# Reads the GachaWiki Discord via the bot token (REST) to inspect channels/messages.
# Usage: python read_music_channel.py guilds|channels|messages <channel_id>
import re
import json
import sys
import urllib.request

VARS_PATH = r"C:\Users\Borin\ZCodeProject\gacha-wiki-bot\.dev.vars"
API = "https://discord.com/api/v10"


def load_token():
    with open(VARS_PATH, "r", encoding="utf-8") as f:
        text = f.read()
    m = re.search(r'DISCORD_TOKEN\s*=\s*"?([^"\r\n]+)"?', text)
    if not m:
        raise SystemExit("DISCORD_TOKEN not found in .dev.vars")
    return m.group(1).strip()


def call(path):
    req = urllib.request.Request(
        API + path,
        headers={
            "Authorization": "Bot " + load_token(),
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) gachawiki-bot-tool/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        raise SystemExit(f"HTTP {e.code} on {path}: {body}")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "guilds"
    if mode == "guilds":
        data = call("/users/@me/guilds")
        for g in data:
            print(g.get("id"), "|", g.get("name"))
    elif mode == "channels":
        guild_id = sys.argv[2]
        data = call(f"/guilds/{guild_id}/channels")
        # type 0 = text channel
        for c in sorted(data, key=lambda x: (x.get("position", 0))):
            print(
                c.get("id"), "|", c.get("type"), "|", "#" + c.get("name", "?"),
                "|", c.get("topic", "")[:60],
            )
    elif mode == "messages":
        channel_id = sys.argv[2]
        limit = int(sys.argv[3]) if len(sys.argv) > 3 else 50
        data = call(f"/channels/{channel_id}/messages?limit={limit}")
        for msg in reversed(data):  # oldest first for readability
            author = msg["author"].get("username", "?")
            ts = msg.get("timestamp", "")
            content = msg.get("content", "").replace("\n", " / ")
            attach = [a.get("filename", "?") + " (" + str(a.get("size", "?")) + "B, " + str(a.get("content_type", "?")) + ")" for a in msg.get("attachments", [])]
            embeds = [e.get("title", "") or (e.get("description", "") or "")[:60] for e in msg.get("embeds", [])]
            print(f"[{ts}] {author}: {content[:400]}")
            if attach:
                print("    attachments:", "; ".join(attach))
            if embeds:
                print("    embeds:", "; ".join(e[:100] for e in embeds))
            print()


if __name__ == "__main__":
    main()
