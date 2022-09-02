import type {CertificateCreationOptions, CertificateCreationResult, PrivateKeyCreationOptions, CSRCreationOptions, Callback} from 'pem';

export type CreateCertificate = (options: CertificateCreationOptions, callback: Callback<CertificateCreationResult>) => void;

export type CreateCsr = (options: CSRCreationOptions, callback: Callback<{csr: string; clientKey: string}>) => void;

export type CreatePrivateKey = (keyBitsize: number, options: PrivateKeyCreationOptions, callback: Callback<{key: string}>) => void;
