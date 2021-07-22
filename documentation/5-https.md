[> Back to homepage](../readme.md#documentation)

## Advanced HTTPS API

### `https`

**Type: `object`**

This option represents the options used to make HTTPS requests.

#### `alpnProtocols`

**Type: `string[]`**\
**Default: `['http/1.1']`**

Acceptable [ALPN](https://en.wikipedia.org/wiki/Application-Layer_Protocol_Negotiation) protocols.

If the `http2` option is `true`, this defaults to `['h2', 'http/1.1']`.

#### `rejectUnauthorized`

**Type: `boolean`**\
**Default: `true`**

If `true`, it will throw on invalid certificates, such as expired or self-signed ones.

#### `checkServerIdentity`

**Type: `(hostname: string, certificate: DetailedPeerCertificate) => Error | undefined`**\
**Default: `tls.checkServerIdentity`**

Custom check of the certificate. Useful for pinning certificates.

The function must return `undefined` if the check succeeded.\
If it failed, an `Error` should be returned.

**Note:**
> - In order to have the function called, the certificate must not be expired, self-signed nor with an untrusted-root.

Check [Node.js docs](https://nodejs.org/api/https.html#https_https_request_url_options_callback) for an example.

#### `certificateAuthority`

**Type: `string | Buffer | string[] | Buffer[]`**

**Note:**
> - The option has been renamed from the [`ca` TLS option](https://nodejs.org/api/tls.html#tls_tls_createsecurecontext_options) for better readability.

Overrides trusted [CA](https://en.wikipedia.org/wiki/Certificate_authority) certificates.

Defaults to CAs provided by [Mozilla](https://ccadb-public.secure.force.com/mozilla/IncludedCACertificateReport).

```js
import got from 'got';

// Single Certificate Authority
await got('https://example.com', {
	https: {
		certificateAuthority: fs.readFileSync('./my_ca.pem')
	}
});
```

#### `key`

**Type: `string | Buffer | string[] | Buffer[] | object[]`**

Private keys in [PEM format](https://en.wikipedia.org/wiki/Privacy-Enhanced_Mail).

Multiple keys with different passphrases can be provided as an array of `{pem: <string | Buffer>, passphrase: <string>}`.

**Note:**
> - Encrypted keys will be decrypted with `https.passphrase`.

#### `passphrase`

**Type: `string`**

Shared passphrase used for a single private key and/or a PFX.

#### `certificate`

**Type: `string | Buffer | string[] | Buffer[]`**

**Note:**
> - The option has been renamed from the [`cert` TLS option](https://nodejs.org/api/tls.html#tls_tls_createsecurecontext_options) for better readability.

[Certificate chains](https://en.wikipedia.org/wiki/X.509#Certificate_chains_and_cross-certification) in [PEM format](https://en.wikipedia.org/wiki/Privacy-Enhanced_Mail).

One certificate chain should be provided per private key.

When providing multiple certificate chains, they do not have to be in the same order as their private keys in `https.key`.

#### `pfx`

**Type: `string | Buffer | string[] | Buffer[] | object[]`**

[PFX or PKCS12](https://en.wikipedia.org/wiki/PKCS_12) encoded private key and certificate chain. Using `https.pfx` is an alternative to providing `https.key` and `https.certificate` individually. A PFX is usually encrypted, then `https.passphrase` will be used to decrypt it.

Multiple PFX can be be provided as an array of unencrypted buffers or an array of objects like:

```ts
{
	buffer: string | Buffer,
	passphrase?: string
}
```

#### `certificateRevocationLists`

**Type: `string | Buffer | string[] | Buffer[]`**

**Note:**
> - The option has been renamed from the [`crl` TLS option](https://nodejs.org/api/tls.html#tls_tls_createsecurecontext_options) for better readability.

### Other HTTPS options

[Documentation for the below options.](https://nodejs.org/api/tls.html#tls_tls_createsecurecontext_options)

- `ciphers`
- `dhparam`
- `signatureAlgorithms` (renamed from `sigalgs`)
- `minVersion`
- `maxVersion`
- `honorCipherOrder`
- `tlsSessionLifetime` (renamed from `sessionTimeout`)
- `ecdhCurve`

### Examples

```js
import got from 'got';

// Single key with certificate
await got('https://example.com', {
	https: {
		key: fs.readFileSync('./client_key.pem'),
		certificate: fs.readFileSync('./client_cert.pem')
	}
});

// Multiple keys with certificates (out of order)
await got('https://example.com', {
	https: {
		key: [
			fs.readFileSync('./client_key1.pem'),
			fs.readFileSync('./client_key2.pem')
		],
		certificate: [
			fs.readFileSync('./client_cert2.pem'),
			fs.readFileSync('./client_cert1.pem')
		]
	}
});

// Single key with passphrase
await got('https://example.com', {
	https: {
		key: fs.readFileSync('./client_key.pem'),
		certificate: fs.readFileSync('./client_cert.pem'),
		passphrase: 'client_key_passphrase'
	}
});

// Multiple keys with different passphrases
await got('https://example.com', {
	https: {
		key: [
			{pem: fs.readFileSync('./client_key1.pem'), passphrase: 'passphrase1'},
			{pem: fs.readFileSync('./client_key2.pem'), passphrase: 'passphrase2'},
		],
		certificate: [
			fs.readFileSync('./client_cert1.pem'),
			fs.readFileSync('./client_cert2.pem')
		]
	}
});

// Single encrypted PFX with passphrase
await got('https://example.com', {
	https: {
		pfx: fs.readFileSync('./fake.pfx'),
		passphrase: 'passphrase'
	}
});

// Multiple encrypted PFX's with different passphrases
await got('https://example.com', {
	https: {
		pfx: [
			{
				buffer: fs.readFileSync('./key1.pfx'),
				passphrase: 'passphrase1'
			},
			{
				buffer: fs.readFileSync('./key2.pfx'),
				passphrase: 'passphrase2'
			}
		]
	}
});

// Multiple encrypted PFX's with single passphrase
await got('https://example.com', {
	https: {
		passphrase: 'passphrase',
		pfx: [
			{
				buffer: fs.readFileSync('./key1.pfx')
			},
			{
				buffer: fs.readFileSync('./key2.pfx')
			}
		]
	}
});
```
