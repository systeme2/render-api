from flask import Flask, request, jsonify
import base64
import json
import moviepy.editor as mp
import tempfile
import os
from werkzeug.exceptions import BadRequest
import logging
import requests  # ✅ pour télécharger la vidéo depuis une URL

# Configuration des logs
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "OK", "service": "Video Processing API"})

@app.route('/process_video', methods=['POST'])
def process_video():
    try:
        logger.info("Début du traitement vidéo")
        
        # Vérifier le Content-Type et récupérer les données
        if request.content_type == 'application/json':
            data = request.get_json()
        else:
            try:
                data = json.loads(request.get_data().decode('utf-8'))
            except:
                data = None
        
        if not data:
            logger.error("Aucune donnée JSON reçue")
            return jsonify({"success": False, "error": "Aucune donnée JSON reçue"}), 400
        
        logger.info(f"Données reçues: {list(data.keys())}")
        
        video_base64 = data.get('video_base64')
        video_url = data.get('video_url')
        num_shorts = int(data.get('num_shorts', 3))

        video_data = None

        if video_base64:
            # Décodage base64
            try:
                video_data = base64.b64decode(video_base64)
                logger.info(f"Données vidéo décodées: {len(video_data)} bytes")
            except Exception as e:
                logger.error(f"Erreur décodage base64: {str(e)}")
                return jsonify({"success": False, "error": f"Erreur décodage base64: {str(e)}"}), 400

        elif video_url:
            # Téléchargement depuis une URL
            try:
                logger.info(f"Téléchargement vidéo depuis {video_url}")
                r = requests.get(video_url, stream=True, timeout=60)
                r.raise_for_status()
                video_data = r.content
                logger.info(f"Téléchargement terminé: {len(video_data)} bytes")
            except Exception as e:
                logger.error(f"Erreur téléchargement vidéo: {str(e)}")
                return jsonify({"success": False, "error": f"Erreur téléchargement vidéo: {str(e)}"}), 400

        else:
            logger.error("Ni video_base64 ni video_url fourni")
            return jsonify({"success": False, "error": "video_base64 ou video_url manquant"}), 400
        
        # Sauvegarder temporairement la vidéo
        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as temp_video:
            temp_video.write(video_data)
            video_path = temp_video.name
        
        logger.info(f"Vidéo sauvegardée: {video_path}")
        
        # Charger la vidéo avec MoviePy
        try:
            video = mp.VideoFileClip(video_path)
            duration = video.duration
            logger.info(f"Durée de la vidéo: {duration}s")
        except Exception as e:
            logger.error(f"Erreur chargement vidéo: {str(e)}")
            os.unlink(video_path)
            return jsonify({"success": False, "error": f"Erreur chargement vidéo: {str(e)}"}), 400
        
        if duration < 30:
            video.close()
            os.unlink(video_path)
            return jsonify({"success": False, "error": "Vidéo trop courte (min 30s)"}), 400
        
        shorts = []
        
        # Créer les shorts
        for i in range(min(num_shorts, 5)):
            logger.info(f"Création du short {i+1}/{num_shorts}")
            
            # Calculer les timings
            segment_duration = duration / num_shorts
            start_time = i * segment_duration + min(10, segment_duration * 0.2)
            end_time = min(duration, start_time + 15)
            
            if end_time - start_time < 5:
                logger.warning(f"Segment {i} trop court, arrêt")
                break
            
            try:
                # Extraire et redimensionner le clip
                clip = video.subclip(start_time, end_time)

                try:
                    clip_resized = clip.resize(height=1920).crop(width=1080)
                except Exception as e:
                    logger.warning(f"Crop échoué ({str(e)}), fallback en simple resize")
                    clip_resized = clip.resize(height=1920)
                
                # Sauvegarder temporairement
                with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as temp_short:
                    clip_resized.write_videofile(
                        temp_short.name, 
                        codec='libx264',
                        audio_codec='aac',
                        temp_audiofile='temp-audio.m4a',
                        remove_temp=True,
                        verbose=True,   # ✅ logs ffmpeg visibles
                        logger=None
                    )
                    
                    # Encoder en base64
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
                    
                    os.unlink(temp_short.name)
                
                clip_resized.close()
                clip.close()
                
            except Exception as e:
                logger.error(f"Erreur création short {i}: {str(e)}")
                continue
        
        # Nettoyer
        video.close()
        os.unlink(video_path)

        # ✅ Si aucun short n'a été créé
        if len(shorts) == 0:
            logger.warning("Aucun short créé")
            return jsonify({
                "success": False,
                "error": "Aucun short généré",
                "original_duration": duration,
                "shorts_created": 0
            }), 400
        
        logger.info(f"Traitement terminé: {len(shorts)} shorts créés")
        
        return jsonify({
            "success": True,
            "shorts": shorts,
            "original_duration": duration,
            "shorts_created": len(shorts)
        })
        
    except Exception as e:
        logger.error(f"Erreur générale: {str(e)}")
        return jsonify({
            "success": False, 
            "error": str(e)
        }), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
