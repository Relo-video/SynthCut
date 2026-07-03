# Code signing — SynthCut by Relo (Windows)

Unsigned installers trigger Windows SmartScreen ("Windows protected your PC").
A **trusted code‑signing certificate** removes/reduces that warning. This doc
explains the options, cost, how to get one, and how to wire it into the build.

## Free or paid?

- **Trusted by end users → PAID.** Certificates that Windows/SmartScreen trust are
  issued by Certificate Authorities (CAs) and cost money (yearly).
- **Self‑signed → FREE, but testing only.** You can make one for free, but it is
  *not* trusted on other people's machines (they'd have to manually install it
  into Trusted Root). It does **not** remove SmartScreen for your users.

## Options & rough cost (USD / year)

| Option | Cost | SmartScreen | Notes |
|---|---|---|---|
| **OV** code signing | ~$80–400/yr | Trust builds up over downloads/time | Most common |
| **EV** code signing | ~$250–700/yr | **Instant** trust, no warning day 1 | Needs hardware token |
| **Azure Trusted Signing** (Microsoft) | ~$10/month | Builds reputation; modern | Cloud, no token, great for orgs |
| **Self‑signed** | Free | Not trusted | Internal testing only |

> Since June 2023, brand‑new OV/EV private keys must live on **hardware** (a USB
> token / HSM) or a **cloud signing service** — you usually can't just download a
> plain `.pfx` for a new OV cert anymore. Cloud signing (Azure Trusted Signing,
> SSL.com eSigner, DigiCert KeyLocker) avoids shipping a physical token.

## Where to buy

DigiCert, Sectigo (Comodo), SSL.com, GlobalSign, Certera; resellers such as
SignMyCode/Codegic are often cheaper. Azure Trusted Signing is in the Azure Portal.

## Steps to get one (typical)

1. **Choose**: cheapest trusted‑for‑users today is **Azure Trusted Signing** or an
   **OV** cert via a reseller; pick **EV** if you want zero SmartScreen warnings
   from the first download.
2. **Purchase** "Code Signing Certificate" (OV/EV) or enable Azure Trusted Signing.
3. **Validate identity** (1–5 business days): business registration / D‑U‑N‑S for a
   company; some CAs validate individuals with a government ID.
4. **Receive**: a hardware token (shipped), cloud‑signing credentials, or (rarely
   now) a `.pfx` file.

## Wiring it into this project (electron-builder 25)

The build is already set up to sign **automatically** when credentials are present —
no code change needed for the common cases. Run from `apps/desktop/`.

### A) `.pfx` file (older / individual certs)

```powershell
$env:CSC_LINK = "C:\path\to\cert.pfx"
$env:CSC_KEY_PASSWORD = "your-pfx-password"
npm run dist
```

It signs both `SynthCut by Relo.exe` and the Setup installer.

### B) Azure Trusted Signing (recommended cloud option)

Add to `package.json` → `build.win`:

```json
"azureSignOptions": {
  "publisherName": "Relo",
  "endpoint": "https://eus.codesigning.azure.net",
  "codeSigningAccountName": "<your-account>",
  "certificateProfileName": "<your-profile>"
}
```

Then set Azure creds and build:

```powershell
$env:AZURE_TENANT_ID = "..."
$env:AZURE_CLIENT_ID = "..."
$env:AZURE_CLIENT_SECRET = "..."
npm run dist
```

### C) Hardware token (EV/OV on USB)

Install the token vendor's CSP (e.g. SafeNet), then sign with `signtool` using the
cert subject name, or an electron-builder `customSign` hook.

## Reputation note

Even with a valid **OV** cert, SmartScreen may still warn until your signed app
builds download reputation. **EV** certs get instant trust; **Azure Trusted
Signing** also accrues reputation over time.
