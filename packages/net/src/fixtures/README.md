# Test-only TLS fixtures

Used by `../pinned-fetch.test.ts` to prove the pinned fetch keeps certificate
validation against the *original hostname* (not the pinned IP) and never
disables `rejectUnauthorized`. **Test-only material** — the server key is
deliberately committed; nothing here is trusted anywhere outside these tests.
The published package ships `dist/` only (see `files` in package.json), so
these never leave the repo.

- `ca.pem` — self-signed test CA (`CN=latch-net test CA`). Its private key was
  discarded after signing; only the cert is needed (tests pass it as `ca`).
- `server.pem` / `server.key` — leaf cert + key for `SAN=DNS:pinned-test.example`,
  signed by the test CA.

Validity is ~100 years. Regenerate with (RSA + explicit `-sha256`: macOS
LibreSSL emits EC keys with explicit curve parameters and SHA-1 signatures by
default, both of which Node's TLS stack rejects):

```sh
openssl req -x509 -sha256 -newkey rsa:2048 -nodes \
  -keyout ca.key -out ca.pem -days 36500 -subj "/CN=latch-net test CA"
openssl req -sha256 -newkey rsa:2048 -nodes \
  -keyout server.key -out server.csr -subj "/CN=pinned-test.example"
openssl x509 -req -sha256 -in server.csr -CA ca.pem -CAkey ca.key \
  -CAcreateserial -days 36500 -out server.pem \
  -extfile <(printf "subjectAltName=DNS:pinned-test.example")
rm server.csr ca.srl ca.key
```
