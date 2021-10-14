import type {Writable, Readable} from 'node:stream';
import type {ClientRequest} from 'node:http';

function isClientRequest(clientRequest: Writable | Readable): clientRequest is ClientRequest {
	return (clientRequest as Writable).writable && !(clientRequest as Writable).writableEnded;
}

export default isClientRequest;
