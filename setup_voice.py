"""Downloads the Piper LibriTTS voice (CC BY 4.0, 904 speakers) into voices/."""
import os
import tarfile
import urllib.request

URL = "https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-en-us-libritts-high.tar.gz"
DEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices")

if __name__ == "__main__":
    os.makedirs(DEST, exist_ok=True)
    archive = os.path.join(DEST, "voice.tar.gz")
    print("downloading", URL)
    urllib.request.urlretrieve(URL, archive)
    with tarfile.open(archive) as t:
        t.extractall(DEST)
    os.remove(archive)
    print("ok:", os.listdir(DEST))
