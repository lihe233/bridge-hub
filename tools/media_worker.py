# 媒体下载守护进程（QQ / 微信附件）
# 说明：插件运行时用的是 dist/main.js 里的 MEDIA_WORKER_SRC，
# 启动时写入 sdcard 后拉起；本文件内容与内嵌源码等价，仅作可读参考。
# 改动请同步 MEDIA_WORKER_SRC，否则下次启动会被内嵌版本覆盖。
import json, os, shutil, time
import urllib.request

HUB = "/storage/emulated/0/Download/Operit/bridge_hub"
MEDIA_DIR = HUB + "/media"
LOG = HUB + "/media.log"
MAX_BYTES = 67108864


def wlog(m):
    try:
        if os.path.getsize(LOG) > 262144:
            with open(LOG, "r", encoding="utf-8", errors="ignore") as f:
                tail = f.readlines()[-200:]
            with open(LOG, "w", encoding="utf-8") as f:
                f.writelines(tail)
    except Exception:
        pass
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(time.strftime("%H:%M:%S ", time.localtime()) + str(m) + chr(10))
    except Exception:
        pass


def guess_ext(raw):
    if not raw:
        return ""
    h = raw[:16]
    if h[:3] == bytes.fromhex("ffd8ff"):
        return ".jpg"
    if h[:8] == bytes.fromhex("89504e470d0a1a0a"):
        return ".png"
    if h[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if h[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return ".webp"
    if h[:4] == b"RIFF" and raw[8:12] == b"WAVE":
        return ".wav"
    if h[4:8] == b"ftyp":
        return ".mp4"
    if h[:4] == b"OggS":
        return ".ogg"
    if h[:3] == b"ID3":
        return ".mp3"
    if h[:4] == b"%PDF":
        return ".pdf"
    if h[:4] == bytes.fromhex("504b0304"):
        return ".zip"
    if h[:2] == b"BM":
        return ".bmp"
    if h[:2] == b"AM":
        return ".amr"
    return ""


def download(job):
    url = str(job.get("url") or "")
    if not url:
        raise Exception("no url")
    rq = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(rq, timeout=60) as r:
        cl = r.headers.get("Content-Length")
        if cl and int(cl) > MAX_BYTES:
            raise Exception("too large " + str(cl))
        chunks = []
        got = 0
        while True:
            part = r.read(262144)
            if not part:
                break
            got += len(part)
            if got > MAX_BYTES:
                raise Exception("too large " + str(got))
            chunks.append(part)
    raw = b"".join(chunks)
    if not raw:
        raise Exception("empty body")
    kh = (job.get("key") or "").strip()
    if kh and len(kh) == 32:
        try:
            from Crypto.Cipher import AES
            from Crypto.Util.Padding import unpad
            raw = unpad(AES.new(bytes.fromhex(kh), AES.MODE_ECB).decrypt(raw), 16)
        except Exception as eK:
            wlog("AES_SKIP " + str(eK)[:80])
    out = job["out"]
    if not os.path.splitext(out)[1]:
        out = out + guess_ext(raw)
    d = os.path.dirname(out)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(out, "wb") as f:
        f.write(raw)
    return out, len(raw)


def main():
    try:
        os.makedirs(MEDIA_DIR, exist_ok=True)
    except Exception:
        pass
    wlog("WORKER_UP pid=%d" % os.getpid())
    while True:
        try:
            names = sorted(os.listdir(MEDIA_DIR))
        except Exception:
            names = []
        for fn in names:
            if fn.startswith("cp_") and fn.endswith(".json"):
                jp = os.path.join(MEDIA_DIR, fn)
                try:
                    jd = json.load(open(jp, encoding="utf-8"))
                    os.makedirs(os.path.dirname(jd["rdst"]), exist_ok=True)
                    shutil.copyfile(jd["src"], jd["rdst"])
                    wlog("CP_OK " + str(jd["rdst"]))
                except Exception as e:
                    wlog("CP_ERR " + str(e)[:100])
                try:
                    os.remove(jp)
                except Exception:
                    pass
                continue
            if not (fn.startswith("job_") and fn.endswith(".json")):
                continue
            jp = os.path.join(MEDIA_DIR, fn)
            tag = fn[4:-5]
            try:
                job = json.load(open(jp, encoding="utf-8"))
            except Exception:
                try:
                    os.remove(jp)
                except Exception:
                    pass
                continue
            if not isinstance(job, dict):
                try:
                    os.remove(jp)
                except Exception:
                    pass
                continue
            try:
                out, n = download(job)
                with open(os.path.join(MEDIA_DIR, "done_" + tag + ".json"), "w", encoding="utf-8") as f:
                    json.dump({"ok": True, "path": out}, f)
                wlog("MEDIA_OK " + str(out) + " " + str(n))
            except Exception as e:
                try:
                    with open(os.path.join(MEDIA_DIR, "done_" + tag + ".json"), "w", encoding="utf-8") as f:
                        json.dump({"ok": False, "err": str(e)[:120]}, f)
                except Exception:
                    pass
                wlog("MEDIA_ERR " + fn + " " + str(e)[:120])
            try:
                os.remove(jp)
            except Exception:
                pass
        time.sleep(0.25)


if __name__ == "__main__":
    main()