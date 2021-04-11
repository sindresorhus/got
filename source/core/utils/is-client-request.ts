import type {Writable, Readable} from 'stream';
import type {ClientRequest} from 'http';

function isClientRequest(clientRequest: Writable | Readable): clientRequest is ClientRequest {
	return (clientRequest as Writable).writable && !(clientRequest as Writable).writableEnded;
}

export default isClientRequest;
