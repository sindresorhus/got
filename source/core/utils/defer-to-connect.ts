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
	let listeners: Listeners;
	if (typeof fn === 'function') {
		const connect = fn;
		listeners = {connect};
	} else {
		listeners = fn;
	}

	const hasConnectListener = typeof listeners.connect === 'function';
	const hasSecureConnectListener = typeof listeners.secureConnect === 'function';
	const hasCloseListener = typeof listeners.close === 'function';

	const onConnect = () => {
		if (hasConnectListener) {
			listeners.connect!();
		}

		if (isTlsSocket(socket) && hasSecureConnectListener) {
			if (socket.authorized) {
				listeners.secureConnect!();
			} else {
				// Wait for secureConnect event (even if authorization fails, we need the timing)
				socket.once('secureConnect', listeners.secureConnect!);
			}
		}

		if (hasCloseListener) {
			socket.once('close', listeners.close!);
		}
	};

	if (socket.writable && !socket.connecting) {
		onConnect();
	} else if (socket.connecting) {
		socket.once('connect', onConnect);
	} else if (socket.destroyed && hasCloseListener) {
		const hadError = '_hadError' in socket ? Boolean((socket as any)._hadError) : false;
		listeners.close!(hadError);
	}
};

export default deferToConnect;
