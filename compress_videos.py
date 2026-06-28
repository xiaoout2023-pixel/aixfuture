import subprocess
import os

FFMPEG = r"C:\Users\32879\AppData\Roaming\Python\Python314\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
VIDEO_DIR = r"c:\Users\32879\Documents\free-model-projects\aix-future-cc\assets\videos"

# 压缩参数：720p, 1Mbps 码率, 15fps (展示用不需要高帧率)
TARGET_W = 1280
TARGET_H = 720
BITRATE = "800k"
FPS = 15

files = [f for f in os.listdir(VIDEO_DIR) if f.lower().endswith(('.mp4', '.MP4'))]
print(f"Found {len(files)} videos")

for fname in files:
    src = os.path.join(VIDEO_DIR, fname)
    # 输出到 compressed 子目录
    out_dir = os.path.join(VIDEO_DIR, "compressed")
    os.makedirs(out_dir, exist_ok=True)
    dst = os.path.join(out_dir, fname.lower().replace('.mp4', '.mp4'))

    size_mb = os.path.getsize(src) / (1024 * 1024)
    print(f"\n[{fname}] {size_mb:.1f}MB -> compressing...")

    cmd = [
        FFMPEG, "-y",
        "-i", src,
        "-vf", f"scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=decrease,pad={TARGET_W}:{TARGET_H}:(ow-iw)/2:(oh-ih)/2",
        "-r", str(FPS),
        "-b:v", BITRATE,
        "-c:v", "libx264",
        "-preset", "medium",
        "-c:a", "aac",
        "-b:a", "64k",
        "-movflags", "+faststart",
        dst
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        new_size = os.path.getsize(dst) / (1024 * 1024)
        ratio = (1 - new_size / size_mb) * 100
        print(f"  OK: {new_size:.1f}MB ({ratio:.0f}% reduction)")
    else:
        print(f"  FAILED: {result.stderr[-200:]}")

print("\nDone!")
