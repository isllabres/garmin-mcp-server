"""Login de Garmin Connect (SSO + MFA), una vez, en tu maquina.

Entra con python-garminconnect, que supera el bloqueo de Garmin de marzo de 2026
imitando la huella TLS de la app, y guarda los tokens DI OAuth2 (di_token,
di_refresh_token, di_client_id) en ~/.garminconnect/garmin_tokens.json, con
permisos 600 dentro de un directorio 700. El refresh token da acceso a la cuenta.

Cada ejecucion entra de cero con email, contrasena y MFA, aunque el fichero ya
exista, y lo sobrescribe: nunca reutiliza ni refresca una sesion guardada. Si
Garmin no entrega tokens DI validos, sale con error sin escribir nada.
"""

import base64
import getpass
import json
import math
import os
import sys

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

TOKEN_DIR = "~/.garminconnect"


def di_session_ok(client) -> bool:
    """Lo que exige parseTokens (src/tokens.ts) en el Worker: tres cadenas no vacias
    y un di_token JWT con un exp numerico finito."""
    fields = (client.di_token, client.di_refresh_token, client.di_client_id)
    if not all(isinstance(v, str) and v for v in fields):
        return False
    parts = client.di_token.split(".")
    if len(parts) != 3:
        return False
    try:
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    except ValueError:  # incluye binascii.Error, JSONDecodeError y UnicodeDecodeError
        return False
    exp = payload.get("exp") if isinstance(payload, dict) else None
    return isinstance(exp, (int, float)) and not isinstance(exp, bool) and math.isfinite(exp)


def main() -> None:
    email = input("Email de Garmin Connect: ").strip()
    password = getpass.getpass("Contrasena: ")
    garmin = Garmin(email, password, prompt_mfa=lambda: input("Codigo MFA: ").strip())
    # Con un tokenstore, login() cargaria el fichero guardado y lo daria por bueno (o
    # lo refrescaria) sin pedir credenciales; su refresh token puede ser uno que el
    # Worker ya roto. Sin tokenstore entra siempre con credenciales. login() lee
    # GARMINTOKENS cuando no se le pasa ninguno, asi que tambien se descarta.
    os.environ.pop("GARMINTOKENS", None)
    try:
        garmin.login()
        # Si el canje DI falla, garminconnect cae a una sesion web (cookie JWT_WEB) con
        # solo un warning: login() acaba bien, pero dump() escribiria los campos DI a
        # null y, cargado en KV, dejaria al Worker sin sesion. Lo mismo si el canje no
        # trae refresh token.
        if not di_session_ok(garmin.client):
            sys.exit("Login sin tokens DI validos: no se ha guardado nada. Reintentalo mas tarde.")
        garmin.client.dump(TOKEN_DIR)
    except (
        GarminConnectAuthenticationError,
        GarminConnectConnectionError,
        GarminConnectTooManyRequestsError,
    ) as e:
        sys.exit(f"Login fallido: {e}")
    print(f"Sesion de {garmin.display_name} guardada en {TOKEN_DIR}/garmin_tokens.json.")
    print("Cargala en el KV del Worker, desde el clon del repo:")
    print("  npx wrangler kv key put tokens --binding GARMIN_KV --remote --path ~/.garminconnect/garmin_tokens.json")
    print("Despues no refresques ese fichero en otro sitio: el refresh token rota y el Worker")
    print("se quedaria sin sesion.")


if __name__ == "__main__":
    main()
