# Censorly for Safari via GitHub Actions

The workflow at `.github/workflows/safari-release.yml` is adapted from the working KJB Reader Safari release workflow. It converts the files in `safari/` into a macOS Safari Web Extension on a GitHub macOS runner.

Without Apple signing secrets, it runs in validation mode and uploads the generated Xcode project. With signing configured, it builds a signed Mac App Store `.pkg` and can upload it to App Store Connect.

## Apple identifiers

Register these explicit App IDs:

- Container app: `com.censorly.extension`
- Safari extension: `com.censorly.extension.Extension`

Create Mac App Store provisioning profiles with these exact profile names:

- `Censorly for Safari Distribution`
- `Censorly for Safari Ext Distribution`

No optional Apple capabilities are required.

## GitHub Actions secrets

Add these under **Settings > Secrets and variables > Actions**:

| Secret | Purpose |
|---|---|
| `MAC_APP_CERTIFICATE_P12` | Base64 Apple Distribution `.p12` |
| `MAC_APP_CERTIFICATE_PASSWORD` | Password for that `.p12` |
| `MAC_INSTALLER_CERTIFICATE_P12` | Base64 Mac Installer Distribution `.p12` |
| `MAC_INSTALLER_CERTIFICATE_PASSWORD` | Password for that `.p12` |
| `MAC_PROVISIONING_PROFILE` | Base64 container-app provisioning profile |
| `MAC_EXTENSION_PROVISIONING_PROFILE` | Base64 Safari-extension provisioning profile |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `KEYCHAIN_PASSWORD` | Temporary CI keychain password |
| `ASC_KEY_ID` | App Store Connect API key ID |
| `ASC_ISSUER_ID` | App Store Connect issuer ID |
| `ASC_KEY_P8` | Base64 App Store Connect `.p8` key |
| `CENSORLY_APPLE_APP_ID` | Numeric Apple ID shown in the Censorly App Store record |

The installer identity follows the KJB Reader workflow and expects `3rd Party Mac Developer Installer: Shawn Hanlin Poh (TEAM_ID)`.

## Run it

1. Open **Actions > Safari Release (Mac App Store) > Run workflow**.
2. Keep **Upload** off for the first run.
3. Configure the signing secrets to generate a signed `.pkg`.
4. Turn **Upload** on only when the Censorly macOS App Store record and numeric Apple ID are ready.
5. Leave the build number blank to use GitHub's unique run number.

Censorly targets Safari 15.4 or newer because it uses Manifest V3 and a background service worker.
