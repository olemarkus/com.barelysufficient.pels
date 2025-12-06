import https from 'https';

// CA certificates for hvakosterstrommen.no (Cloudflare + SSL.com chain)
// These are included to work around Homey's incomplete CA certificate bundle.
// The chain is: hvakosterstrommen.no -> Cloudflare TLS Issuing ECC CA 1 -> SSL.com TLS Transit ECC CA R2 -> AAA Certificate Services

// AAA Certificate Services (Comodo Root CA) - expires 2028-12-31
const COMODO_AAA_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIEMjCCAxqgAwIBAgIBATANBgkqhkiG9w0BAQUFADB7MQswCQYDVQQGEwJHQjEb
MBkGA1UECAwSR3JlYXRlciBNYW5jaGVzdGVyMRAwDgYDVQQHDAdTYWxmb3JkMRow
GAYDVQQKDBFDb21vZG8gQ0EgTGltaXRlZDEhMB8GA1UEAwwYQUFBIENlcnRpZmlj
YXRlIFNlcnZpY2VzMB4XDTA0MDEwMTAwMDAwMFoXDTI4MTIzMTIzNTk1OVowezEL
MAkGA1UEBhMCR0IxGzAZBgNVBAgMEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UE
BwwHU2FsZm9yZDEaMBgGA1UECgwRQ29tb2RvIENBIExpbWl0ZWQxITAfBgNVBAMM
GEFBQSBDZXJ0aWZpY2F0ZSBTZXJ2aWNlczCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAL5AnfRu4ep2hxxNRUSOvkbIgwadwSr+GB+O5AL686tdUIoWMQua
BtDFcCLNSS1UY8y2bmhGC1Pqy0wkwLxyTurxFa70VJoSCsN6sjNg4tqJVfMiWPPe
3M/vg4aijJRPn2jymJBGhCfHdr/jzDUsi14HZGWCwEiwqJH5YZ92IFCokcdmtet4
YgNW8IoaE+oxox6gmf049vYnMlhvB/VruPsUK6+3qszWY19zjNoFmag4qMsXeDZR
rOme9Hg6jc8P2ULimAyrL58OAd7vn5lJ8S3frHRNG5i1R8XlKdH5kBjHYpy+g8cm
ez6KJcfA3Z3mNWgQIJ2P2N7Sw4ScDV7oL8kCAwEAAaOBwDCBvTAdBgNVHQ4EFgQU
oBEKIz6W8Qfs4q8p74Klf9AwpLQwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQF
MAMBAf8wewYDVR0fBHQwcjA4oDagNIYyaHR0cDovL2NybC5jb21vZG9jYS5jb20v
QUFBQ2VydGlmaWNhdGVTZXJ2aWNlcy5jcmwwNqA0oDKGMGh0dHA6Ly9jcmwuY29t
b2RvLm5ldC9BQUFDZXJ0aWZpY2F0ZVNlcnZpY2VzLmNybDANBgkqhkiG9w0BAQUF
AAOCAQEACFb8AvCb6P+k+tZ7xkSAzk/ExfYAWMymtrwUSWgEdujm7l3sAg9g1o1Q
GE8mTgHj5rCl7r+8dFRBv/38ErjHT1r0iWAFf2C3BUrz9vHCv8S5dIa2LX1rzNLz
Rt0vxuBqw8M0Ayx9lt1awg6nCpnBBYurDC/zXDrPbDdVCYfeU0BsWO/8tqtlbgT2
G9w84FoVxp7Z8VlIMCFlA2zs6SFz7JsDoeA3raAVGI/6ugLOpyypEBMs1OUIJqsi
l2D4kF501KKaU73yqWjgom7C12yxow+ev+to51byrvLjKzg6CYG1a4XXvi3tPxq3
smPi9WIsgtRqAEFQ8TmDn5XpNpaYbg==
-----END CERTIFICATE-----`;

// SSL.com TLS Transit ECC CA R2 (Intermediate) - expires 2028-12-31
const SSL_COM_TRANSIT_CA = `-----BEGIN CERTIFICATE-----
MIID0DCCArigAwIBAgIRAK2NLfZGgaDTZEfqqU+ic8EwDQYJKoZIhvcNAQELBQAw
ezELMAkGA1UEBhMCR0IxGzAZBgNVBAgMEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4G
A1UEBwwHU2FsZm9yZDEaMBgGA1UECgwRQ29tb2RvIENBIExpbWl0ZWQxITAfBgNV
BAMMGEFBQSBDZXJ0aWZpY2F0ZSBTZXJ2aWNlczAeFw0yNDA2MjEwMDAwMDBaFw0y
ODEyMzEyMzU5NTlaME8xCzAJBgNVBAYTAlVTMRgwFgYDVQQKDA9TU0wgQ29ycG9y
YXRpb24xJjAkBgNVBAMMHVNTTC5jb20gVExTIFRyYW5zaXQgRUNDIENBIFIyMHYw
EAYHKoZIzj0CAQYFK4EEACIDYgAEZOd9mQNTXJEe6vjYI62hvyziY4nvKGj27dfw
7Ktorncr5HaXG1Dr21koLW+4NrmrjZfKTCKe7onZAj/9enM6kI0rzC86N4PaDbQt
RRtzcgllX3ghPeeLZj9H/Qkp1hQPo4IBJzCCASMwHwYDVR0jBBgwFoAUoBEKIz6W
8Qfs4q8p74Klf9AwpLQwHQYDVR0OBBYEFDKix9hYi/9/wDzyVWkz7M7MH7yXMA4G
A1UdDwEB/wQEAwIBhjASBgNVHRMBAf8ECDAGAQH/AgEBMB0GA1UdJQQWMBQGCCsG
AQUFBwMBBggrBgEFBQcDAjAjBgNVHSAEHDAaMAgGBmeBDAECATAOBgwrBgEEAYKp
MAEDAQEwQwYDVR0fBDwwOjA4oDagNIYyaHR0cDovL2NybC5jb21vZG9jYS5jb20v
QUFBQ2VydGlmaWNhdGVTZXJ2aWNlcy5jcmwwNAYIKwYBBQUHAQEEKDAmMCQGCCsG
AQUFBzABhhhodHRwOi8vb2NzcC5jb21vZG9jYS5jb20wDQYJKoZIhvcNAQELBQAD
ggEBAB4oL4ChKaKGZVZK8uAXjj8wvFdm45uvhU/t14QeH5bwETeKiQQXBga4/Nyz
zvpfuoEycantX+tHl/muwpmuHT0Z6IKYoICaMxOIktcTF4qHvxQW2WItHjOglrTj
qlXJXVL+3HCO60TEloSX8eUGsqfLQkc//z3Lb4gz117+fkDbnPt8+2REq3SCvaAG
hlh/lWWfHqTAiHed/qqzBSYqqvfjNlhIfXnPnhfAv/PpOUO1PmxCEAEYrg+VoS+O
+EBd1zkT0V7CfrPpj30cAMs2h+k4pPMwcLuB3Ku4TncBTRyt5K0gbJ3pQ0Rk9Hmu
wOz5QAZ+2n1q4TlApJzBfwFrCDg=
-----END CERTIFICATE-----`;

// Combined CA bundle for pinned hosts
export const PINNED_CA_BUNDLE = `${COMODO_AAA_ROOT_CA}\n${SSL_COM_TRANSIT_CA}`;

export interface HttpsJsonOptions {
  allowInsecureFallback?: boolean;
  log?: (...args: unknown[]) => void;
  pinnedHosts?: string[];
  timeoutMs?: number;
}

/**
  * Make an HTTPS GET request and parse JSON response.
  * For hvakosterstrommen.no, uses pinned CA certificates to work around Homey's incomplete CA bundle.
  * Falls back to insecure connection only if pinned CA verification fails (e.g., CA changed).
  */
export function httpsGetJson(url: string, options: HttpsJsonOptions = {}): Promise<unknown> {
  const {
    allowInsecureFallback = true,
    log,
    pinnedHosts = ['hvakosterstrommen.no'],
    timeoutMs = 10000,
  } = options;

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isPinnedHost = pinnedHosts.some((host) => urlObj.hostname === host || urlObj.hostname.endsWith(`.${host}`));

    const makeRequest = (requestOptions: { rejectUnauthorized: boolean; ca?: string }) => {
      const req = https.get(
        url,
        {
          headers: { Accept: 'application/json' },
          ...requestOptions,
        },
        (res) => {
          if (res.statusCode === 404) {
            const err = new Error('Not found') as Error & { statusCode: number };
            err.statusCode = 404;
            reject(err);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            return;
          }

          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (_e) {
              reject(new Error('Failed to parse JSON response'));
            }
          });
        },
      );

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (requestOptions.rejectUnauthorized && allowInsecureFallback && isSslError(err)) {
          log?.(`SSL verification failed for ${url}, retrying with insecure fallback`);
          makeRequest({ rejectUnauthorized: false });
          return;
        }
        reject(err);
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    };

    if (isPinnedHost) {
      makeRequest({ rejectUnauthorized: true, ca: PINNED_CA_BUNDLE });
    } else {
      makeRequest({ rejectUnauthorized: true });
    }
  });
}

/**
 * Check if an error is an SSL/TLS certificate error.
 */
export function isSslError(err: NodeJS.ErrnoException): boolean {
  const sslErrorCodes = [
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_CHAIN_TOO_LONG',
    'CERT_REVOKED',
    'CERT_UNTRUSTED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ];
  return sslErrorCodes.includes(err.code || '') || (err.message || '').includes('certificate');
}
