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




import shutil
import time

def save_base64_to_file(b64, out_path):
    data = base64.b64decode(b64)
    with open(out_path, "wb") as f:
        f.write(data)
    return out_path

def extract_clip_ffmpeg(input_path, start, length, out_path):
    cmd = [
        FFMPEG_BIN,
        "-ss", str(start),
        "-i", input_path,
        "-t", str(length),
        "-c:v", "libx264",
        "-c:a", "aac",
        "-movflags", "+faststart",
        "-y",
        out_path
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return os.path.exists(out_path)

@app.route("/process_clip", methods=["POST"])
def process_clip():
    """
    POST JSON:
    {
      "video_url": "...",        # ou "file_base64": "..."
      "start_time": 90.2,        # seconde
      "clip_length": 15          # secondes (optionnel, default 15)
    }
    RETURN:
    { "status":"success", "file_base64":"...", "filename":"clip_90_169...mp4" }
    """
    try:
        data = request.get_json(force=True)
        video_url = data.get("video_url")
        file_b64 = data.get("file_base64")
        start_time = float(data.get("start_time", 0))
        clip_length = float(data.get("clip_length", 15))

        if not video_url and not file_b64:
            return jsonify({"status":"error","message":"Provide video_url or file_base64"}), 400

        tmpdir = tempfile.mkdtemp(prefix="pc_")
        in_path = os.path.join(tmpdir, "input.mp4")
        out_path = os.path.join(tmpdir, "clip.mp4")

        # Save input
        if file_b64:
            save_base64_to_file(file_b64, in_path)
        else:
            download_video(video_url, in_path)

        # Extract clip
        ok = extract_clip_ffmpeg(in_path, start_time, clip_length, out_path)
        if not ok:
            return jsonify({"status":"error","message":"Clip extraction failed"}), 500

        with open(out_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")

        filename = f"clip_{int(start_time)}_{int(time.time())}.mp4"

        return jsonify({"status":"success", "file_base64": b64, "filename": filename})
    except Exception as e:
        return jsonify({"status":"error", "message": str(e)}), 500
    finally:
        try:
            shutil.rmtree(tmpdir)
        except Exception:
            pass
