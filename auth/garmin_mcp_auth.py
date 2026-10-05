"""Login de Garmin Connect (SSO + MFA), una vez, en tu maquina.

Entra con python-garminconnect, que supera el bloqueo de Garmin de marzo de 2026
imitando la huella TLS de la app, y guarda los tokens DI OAuth2 (di_token,
di_refresh_token, di_client_id) en ~/.garminconnect/garmin_tokens.json, con
permisos 600 dentro de un directorio 700. El refresh token da acceso a la cuenta.
"""

import getpass
import sys

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

TOKEN_DIR = "~/.garminconnect"


def main() -> None:
    email = input("Email de Garmin Connect: ").strip()
    password = getpass.getpass("Contrasena: ")
    garmin = Garmin(email, password, prompt_mfa=lambda: input("Codigo MFA: ").strip())
    try:
        garmin.login(TOKEN_DIR)
        # login() guarda los tokens pero ignora un fallo al escribirlos: se repite
        # aqui para que un fallo salga como error.
        garmin.client.dump(TOKEN_DIR)
    except (
        GarminConnectAuthenticationError,
        GarminConnectConnectionError,
        GarminConnectTooManyRequestsError,
    ) as e:
        sys.exit(f"Login fallido: {e}")
    print(f"Sesion de {garmin.display_name} guardada en {TOKEN_DIR}/garmin_tokens.json.")


if __name__ == "__main__":
    main()
