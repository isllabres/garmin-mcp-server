"""Login de Garmin Connect (SSO + MFA), una vez, en tu maquina.

Guarda oauth1_token.json y oauth2_token.json en ~/.garminconnect con garth. El
contenido de oauth1_token.json es el secreto GARMIN_OAUTH1 del Worker: da acceso
total a la cuenta durante ~1 anio, asi que los ficheros quedan solo para ti.
"""

import getpass
import os
import sys

import garth
from garth.exc import GarthException

TOKEN_DIR = os.path.expanduser("~/.garminconnect")
TOKEN_FILES = ("oauth1_token.json", "oauth2_token.json")


def main() -> None:
    email = input("Email de Garmin Connect: ").strip()
    password = getpass.getpass("Contrasena: ")
    try:
        garth.login(email, password, prompt_mfa=lambda: input("Codigo MFA: ").strip())
        # Comprueba que la sesion sirve antes de guardar nada.
        name = garth.connectapi("/userprofile-service/socialProfile")["displayName"]
    except GarthException as e:
        sys.exit(f"Login fallido: {e}")

    old_umask = os.umask(0o077)
    try:
        garth.save(TOKEN_DIR)
    finally:
        os.umask(old_umask)
    # umask no cambia un directorio o ficheros que ya existian.
    os.chmod(TOKEN_DIR, 0o700)
    for f in TOKEN_FILES:
        os.chmod(os.path.join(TOKEN_DIR, f), 0o600)

    oauth1 = os.path.join(TOKEN_DIR, TOKEN_FILES[0])
    print(f"Sesion de {name} guardada en {TOKEN_DIR}.")
    print("Sube el token al Worker con:")
    print(f"  npx wrangler secret put GARMIN_OAUTH1 < {oauth1}")


if __name__ == "__main__":
    main()
