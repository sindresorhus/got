import type {
	CertificateCreationOptions,
	CertificateCreationResult,
	PrivateKeyCreationOptions,
	CSRCreationOptions,
	Callback
} from 'pem';

export interface CreateCertificate {
	(options: CertificateCreationOptions, callback: Callback<CertificateCreationResult>): void
}

export interface CreateCSR {
	(options: CSRCreationOptions, callback: Callback<{ csr: string, clientKey: string }>): void
}

export interface CreatePrivateKey {
	(keyBitsize: number, options: PrivateKeyCreationOptions, callback: Callback<{ key: string }>): void
}
