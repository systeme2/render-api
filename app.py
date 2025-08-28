import os
import subprocess
import tempfile
import requests
import base64
from flask import Flask, request, jsonify
import cv2
import numpy as np

app = Flask(__name__)

FFMPEG_BIN = "ffmpeg"  # Render a déjà ffmpeg

def download_video(video_url, output_path):
    """Télécharge la vidéo depuis une URL"""
    r = requests.get(video_url, stream=True)
    r.raise_for_status()
    with open(output_path, 'wb') as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)
    return output_path

def get_video_duration(path):
    """Récupère la durée d’une vidéo (en secondes)"""
    result = subprocess.run(
        [FFMPEG_BIN, "-i", path],
        stderr=subprocess.PIPE, stdout=subprocess.PIPE, text=True
    )
    for line in result.stderr.splitlines():
        if "Duration" in line:
            h, m, s = line.split(",")[0].split("Duration:")[1].strip().split(":")
            duration = int(h) * 3600 + int(m) * 60 + float(s)
            return duration
    return None

def create_shorts(video_path, num_shorts, short_length=60):
    """Découpe la vidéo en plusieurs shorts et retourne en base64"""
    duration = get_video_duration(video_path)
    if not duration:
        raise ValueError("Impossible de déterminer la durée de la vidéo")

    shorts = []
    segment_duration = duration / num_shorts

    for i in range(num_shorts):
        start = int(i * segment_duration)
        out_path = f"/tmp/short_{i+1}.mp4"

        cmd = [
            FFMPEG_BIN,
            "-ss", str(start),
            "-t", str(short_length),
            "-i", video_path,
            "-c", "copy",   # découpe rapide sans ré-encodage
            out_path,
            "-y"
        ]
        subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # Encoder en base64
        with open(out_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")

        shorts.append({
            "file_base64": b64,
            "filename": f"short_{i+1}.mp4"
        })

    return shorts


# -------------------------------
# Étape 2 : Détection Highlights
# -------------------------------

def detect_highlights(video_path, threshold=50):
    """
    Détecte les moments 'dynamiques' dans une vidéo (but, dribble, action rapide)
    Retourne une liste de timestamps (en secondes).
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError("Impossible d’ouvrir la vidéo")

    fps = cap.get(cv2.CAP_PROP_FPS)
    prev_frame = None
    highlights = []
    frame_number = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (21, 21), 0)

        if prev_frame is not None:
            diff = cv2.absdiff(prev_frame, gray)
            score = np.sum(diff) / diff.size

            # Si mouvement > seuil, on marque un highlight
            if score > threshold:
                timestamp = frame_number / fps
                highlights.append(timestamp)

        prev_frame = gray
        frame_number += 1

    cap.release()
    return highlights


# -------------------------------
# Endpoint découpage vidéo
# -------------------------------

@app.route("/process_video", methods=["POST"])
def process_video():
    """Endpoint principal : reçoit une vidéo + num_shorts → retourne shorts en base64"""
    try:
        data = request.json
        video_url = data.get("video_url")
        num_shorts = int(data.get("num_shorts", 1))
        short_length = int(data.get("short_length", 60))

        if not video_url:
            return jsonify({"error": "Missing video_url"}), 400

        # Télécharger la vidéo
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as tmpfile:
            download_video(video_url, tmpfile.name)

            # Générer les shorts
            shorts = create_shorts(tmpfile.name, num_shorts, short_length)

        return jsonify({
            "status": "success",
            "shorts": shorts
        })

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


# -------------------------------
# Endpoint détection highlights
# -------------------------------

@app.route("/detect_highlights", methods=["POST"])
def detect_highlights_endpoint():
    """Analyse une vidéo et retourne les moments forts (timestamps)"""
    try:
        data = request.json
        video_url = data.get("video_url")
        threshold = int(data.get("threshold", 50))

        if not video_url:
            return jsonify({"error": "Missing video_url"}), 400

        # Télécharger la vidéo temporaire
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as tmpfile:
            download_video(video_url, tmpfile.name)

            # Détecter les moments forts
            highlights = detect_highlights(tmpfile.name, threshold)

        return jsonify({
            "status": "success",
            "highlights": highlights
        })

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
