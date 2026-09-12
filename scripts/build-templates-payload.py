"""
Construye el payload de 8 campos para el PATCH parcial de Supabase Auth.

Fuente de verdad:
  - subjects  -> supabase/config.toml  ([auth.email.template.<tipo>].subject)
  - contenido -> email-templates/<archivo>.html (bytes exactos, UTF-8, sin BOM)

Uso (modo dry-run):
  python build-templates-payload.py

Uso (modo generador, usado por patch-email-templates.ps1):
  python build-templates-payload.py --out <path.json>
"""
import hashlib
import json
import os
import sys
import tomllib

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

MAPPING = [
    ("confirmation", "confirm-signup.html"),
    ("recovery", "reset-password.html"),
    ("magic_link", "otp.html"),
    ("email_change", "change-email.html"),
]

KEY_SUBJECT = {
    "confirmation": "mailer_subjects_confirmation",
    "recovery": "mailer_subjects_recovery",
    "magic_link": "mailer_subjects_magic_link",
    "email_change": "mailer_subjects_email_change",
}
KEY_CONTENT = {
    "confirmation": "mailer_templates_confirmation_content",
    "recovery": "mailer_templates_recovery_content",
    "magic_link": "mailer_templates_magic_link_content",
    "email_change": "mailer_templates_email_change_content",
}

CONFIG_PATH = os.path.join(REPO_ROOT, "supabase", "config.toml")
HTML_DIR = os.path.join(REPO_ROOT, "email-templates")

EXPECTED_KEYS = set(KEY_SUBJECT.values()) | set(KEY_CONTENT.values())


def build():
    with open(CONFIG_PATH, "rb") as fh:
        cfg = tomllib.load(fh)
    template_cfg = cfg["auth"]["email"]["template"]

    payload = {}
    manifest = []
    for tkey, fname in MAPPING:
        if tkey not in template_cfg:
            raise SystemExit(f"config.toml lacks [auth.email.template.{tkey}]")
        subject = template_cfg[tkey]["subject"]
        html_path = os.path.join(HTML_DIR, fname)
        with open(html_path, "rb") as fh:
            raw = fh.read()
        if raw[:3] == b"\xef\xbb\xbf":
            raise SystemExit(f"{fname}: file has BOM, aborting (expect no-BOM)")
        content = raw.decode("utf-8")
        payload[KEY_SUBJECT[tkey]] = subject
        payload[KEY_CONTENT[tkey]] = content
        manifest.append(
            {
                "template": tkey,
                "html_file": fname,
                "subject": subject,
                "html_bytes": len(raw),
                "html_sha256": hashlib.sha256(raw).hexdigest(),
            }
        )

    if set(payload.keys()) != EXPECTED_KEYS:
        raise SystemExit(f"Unexpected key set: {sorted(payload.keys())}")

    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    body_bytes = body.encode("utf-8")
    body_sha256 = hashlib.sha256(body_bytes).hexdigest()

    return payload, manifest, body_bytes, body_sha256


def main():
    payload, manifest, body_bytes, body_sha256 = build()
    out_flag = "--out"
    out_path = None
    if out_flag in sys.argv:
        idx = sys.argv.index(out_flag)
        out_path = sys.argv[idx + 1]

    if out_path:
        with open(out_path, "wb") as fh:
            fh.write(body_bytes)

    report = {
        "n_keys": len(payload),
        "keys": list(payload.keys()),
        "manifest": manifest,
        "payload_sha256": body_sha256,
        "payload_bytes": len(body_bytes),
        "payload_out": out_path,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()