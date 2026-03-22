import type {Socket} from 'node:net';
import type {TLSSocket} from 'node:tls';

type Listeners = {
	connect?: () => void;
	secureConnect?: () => void;
	close?: (hadError: boolean) => void;
};

function isTlsSocket(socket: Socket | TLSSocket): socket is TLSSocket {
	return 'encrypted' in socket;
}

const deferToConnect = (socket: TLSSocket | Socket, fn: Listeners | (() => void)): void => {
	const listeners = typeof fn === 'function' ? {connect: fn} : fn;

	const onConnect = () => {
		listeners.connect?.();

		if (isTlsSocket(socket) && listeners.secureConnect) {
			if (socket.authorized) {
				listeners.secureConnect();
			} else {
				// Wait for secureConnect event (even if authorization fails, we need the timing)
				socket.once('secureConnect', listeners.secureConnect);
			}
		}

		if (listeners.close) {
			socket.once('close', listeners.close);
		}
	};

	if (socket.writable && !socket.connecting) {
		onConnect();
	} else if (socket.connecting) {
		socket.once('connect', onConnect);
	} else if (socket.destroyed && listeners.close) {
		const hadError = '_hadError' in socket ? Boolean((socket as any)._hadError) : false;
		listeners.close(hadError);
	}
};

export default deferToConnect;
