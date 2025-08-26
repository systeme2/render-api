from flask import Flask, request, jsonify
import base64
import json
import moviepy.editor as mp
import tempfile
import os
from werkzeug.exceptions import BadRequest

app = Flask(__name__)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "OK", "service": "Video Processing API"})

@app.route('/process_video', methods=['POST'])
def process_video():
    try:
        # Récupérer les données JSON
        data = request.get_json()
        if not data:
            return jsonify({"success": False, "error": "Pas de données JSON"}), 400
        
        video_base64 = data.get('video_base64')
        num_shorts = int(data.get('num_shorts', 3))
        
        if not video_base64:
            return jsonify({"success": False, "error": "video_base64 manquant"}), 400
        
        # Décoder et sauvegarder la vidéo
        video_data = base64.b64decode(video_base64)
        
        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as temp_video:
            temp_video.write(video_data)
            video_path = temp_video.name
        
        # Charger la vidéo avec MoviePy
        video = mp.VideoFileClip(video_path)
        duration = video.duration
        
        if duration < 30:
            video.close()
            os.unlink(video_path)
            return jsonify({"success": False, "error": "Vidéo trop courte (min 30s)"}), 400
        
        shorts = []
        
        # Créer les shorts
        for i in range(min(num_shorts, 5)):  # Maximum 5 shorts
            # Calculer les timings
            segment_duration = duration / num_shorts
            start_time = i * segment_duration + min(10, segment_duration * 0.2)
            end_time = min(duration, start_time + 15)
            
            if end_time - start_time < 5:
                break
            
            # Extraire et redimensionner le clip
            clip = video.subclip(start_time, end_time)
            
            # Redimensionner pour format vertical (9:16)
            clip_resized = clip.resize(height=1920).crop(width=1080)
            
            # Sauvegarder temporairement
            with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as temp_short:
                clip_resized.write_videofile(
                    temp_short.name, 
                    codec='libx264',
                    audio_codec='aac',
                    temp_audiofile='temp-audio.m4a',
                    remove_temp=True,
                    verbose=False,
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
                
                # Nettoyer le fichier temporaire
                os.unlink(temp_short.name)
            
            clip_resized.close()
            clip.close()
        
        # Nettoyer
        video.close()
        os.unlink(video_path)
        
        return jsonify({
            "success": True,
            "shorts": shorts,
            "original_duration": duration,
            "shorts_created": len(shorts)
        })
        
    except Exception as e:
        return jsonify({
            "success": False, 
            "error": str(e)
        }), 500

if __name__ == '__main__':
    # Pour Render.com, utiliser le port fourni par la variable d'environnement
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
