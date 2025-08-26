from flask import Flask, request, jsonify
import base64
import json
import moviepy.editor as mp
import tempfile
import os
import logging
import requests
import subprocess
try:
    import imageio_ffmpeg as iio_ffmpeg
except Exception:
    iio_ffmpeg = None

# Logs
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

def ffmpeg_info():
    """Log la version de ffmpeg utilisée (utile pour le debug Render)."""
    try:
        if iio_ffmpeg:
            ffmpeg_path = iio_ffmpeg.get_ffmpeg_exe()
        else:
            ffmpeg_path = "ffmpeg"
        res = subprocess.run([ffmpeg_path, "-version"], capture_output=True, text=True, timeout=5)
        logger.info(f"FFmpeg path: {ffmpeg_path}")
        logger.info(f"FFmpeg version head: {res.stdout.splitlines()[0] if res.stdout else 'N/A'}")
    except Exception as e:
        logger.warning(f"Impossible d'afficher la version de ffmpeg: {e}")

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "OK", "service": "Video Processing API"})

@app.route('/process_video', methods=['POST'])
def process_video():
    try:
        logger.info("Début du traitement vidéo")
        ffmpeg_info()

        # Récup JSON même si content-type foireux
        if request.content_type == 'application/json':
            data = request.get_json(silent=True)
        else:
            try:
                data = json.loads(request.get_data().decode('utf-8'))
            except Exception:
                data = None

        if not data:
            logger.error("Aucune donnée JSON reçue")
            return jsonify({"success": False, "error": "Aucune donnée JSON reçue"}), 400

        logger.info(f"Données reçues: {list(data.keys())}")

        video_base64 = data.get('video_base64')
        video_url = data.get('video_url')
        num_shorts = int(data.get('num_shorts', 3))

        # --- Charger la vidéo en mémoire ---
        video_data = None
        if video_base64:
            try:
                video_data = base64.b64decode(video_base64)
                logger.info(f"Données vidéo décodées: {len(video_data)} bytes")
            except Exception as e:
                logger.error(f"Erreur décodage base64: {e}")
                return jsonify({"success": False, "error": f"Erreur décodage base64: {e}"}), 400
        elif video_url:
            try:
                logger.info(f"Téléchargement vidéo depuis {video_url}")
                r = requests.get(video_url, stream=True, timeout=60)
                r.raise_for_status()
                video_data = r.content
                logger.info(f"Téléchargement terminé: {len(video_data)} bytes")
            except Exception as e:
                logger.error(f"Erreur téléchargement vidéo: {e}")
                return jsonify({"success": False, "error": f"Erreur téléchargement vidéo: {e}"}), 400
        else:
            logger.error("Ni video_base64 ni video_url fourni")
            return jsonify({"success": False, "error": "video_base64 ou video_url manquant"}), 400

        # --- Sauvegarde temporaire ---
        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as temp_video:
            temp_video.write(video_data)
            video_path = temp_video.name
        logger.info(f"Vidéo sauvegardée: {video_path}")

        # --- Ouverture MoviePy ---
        try:
            video = mp.VideoFileClip(video_path)
            duration = video.duration
            logger.info(f"Durée de la vidéo: {duration:.2f}s")
        except Exception as e:
            logger.error(f"Erreur chargement vidéo: {e}")
            os.unlink(video_path)
            return jsonify({"success": False, "error": f"Erreur chargement vidéo: {e}"}), 400

        if duration < 30:
            video.close()
            os.unlink(video_path)
            return jsonify({"success": False, "error": "Vidéo trop courte (min 30s)"}), 400

        shorts = []
        debug_errors = []

        # --- Création des shorts ---
        for i in range(min(max(num_shorts, 1), 5)):
            logger.info(f"Création du short {i+1}/{num_shorts}")
            segment_duration = duration / max(num_shorts, 1)

            # Décalage pour éviter têtes/tails trop proches
            offset = min(10, segment_duration * 0.2)
            start_time = i * segment_duration + offset
            end_time = min(duration, start_time + 15)

            # Sécurité
            if end_time - start_time < 5:
                msg = f"Segment {i} trop court ({end_time-start_time:.2f}s), arrêt"
                logger.warning(msg)
                debug_errors.append(msg)
                break

            try:
                clip = video.subclip(start_time, end_time)

                # Essai crop 9:16 centré
                try:
                    # On scale en hauteur 1920 puis crop au centre à 1080 de large
                    c = clip.resize(height=1920)
                    clip_resized = c.crop(x_center=c.w/2, width=1080)
                except Exception as e:
                    # Fallback : simple resize hauteur 1920 (pas strictement 9:16)
                    logger.warning(f"Crop échoué (clip {i}): {e} -> fallback resize")
                    debug_errors.append(f"crop_fail_clip_{i}: {e}")
                    clip_resized = clip.resize(height=1920)

                # Export
                with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as temp_short:
                    # audio temp unique
                    temp_audio = tempfile.NamedTemporaryFile(suffix='.m4a', delete=False)
                    temp_audio_path = temp_audio.name
                    temp_audio.close()

                    try:
                        clip_resized.write_videofile(
                            temp_short.name,
                            codec='libx264',
                            audio_codec='aac',
                            temp_audiofile=temp_audio_path,
                            remove_temp=True,
                            fps=30,               # ✅ stabilise ffmpeg
                            preset="ultrafast",   # ✅ rapide et tolérant en prod
                            threads=1,            # ✅ limite la conso CPU
                            verbose=True,         # logs ffmpeg (dans stdout)
                            logger=None
                        )
                    except Exception as e:
                        msg = f"ffmpeg/write_videofile échec clip {i}: {e}"
                        logger.error(msg)
                        debug_errors.append(msg)
                        # Nettoyage fichiers partiels
                        try:
                            if os.path.exists(temp_short.name): os.unlink(temp_short.name)
                            if os.path.exists(temp_audio_path): os.unlink(temp_audio_path)
                        except Exception:
                            pass
                        # On passe au clip suivant
                        clip_resized.close()
                        clip.close()
                        continue

                    # Encoder le résultat si export OK
                    with open(temp_short.name, 'rb') as f:
                        short_base64 = base64.b64encode(f.read()).decode()

                    shorts.append({
                        'file_base64': short_base64,
                        'type': 'but' if i % 2 == 0 else 'dribble',
                        'timestamp': start_time,
                        'duration': end_time - start_time,
                        'index': i
                    })

                    logger.info(f"Short {i+1} créé avec succès")

                    # Nettoyage
                    try:
                        os.unlink(temp_short.name)
                    except Exception:
                        pass

                clip_resized.close()
                clip.close()

            except Exception as e:
                msg = f"Erreur création short {i}: {e}"
                logger.error(msg)
                debug_errors.append(msg)
                continue

        # Nettoyage global
        video.close()
        os.unlink(video_path)

        # Rien créé → renvoyer des détails
        if len(shorts) == 0:
            logger.warning("Aucun short créé")
            return jsonify({
                "success": False,
                "error": "Aucun short généré",
                "original_duration": duration,
                "shorts_created": 0,
                "debug_errors": debug_errors
            }), 400

        logger.info(f"Traitement terminé: {len(shorts)} shorts créés")
        return jsonify({
            "success": True,
            "shorts": shorts,
            "original_duration": duration,
            "shorts_created": len(shorts),
            "debug_errors": debug_errors  # utile même en succès
        })

    except Exception as e:
        logger.error(f"Erreur générale: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
