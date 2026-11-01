import type {Writable, Readable} from 'node:stream';
import type {ClientRequest} from 'node:http';

function isClientRequest(clientRequest: Writable | Readable): clientRequest is ClientRequest {
	// The request remains a request after its upload has ended.
	return typeof (clientRequest as ClientRequest).setHeader === 'function';
}

export default isClientRequest;
