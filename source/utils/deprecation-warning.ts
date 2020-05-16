const alreadyWarned: string[] = [];

export default (name: string, message: string) => {
	if (alreadyWarned.includes(name)) {
		return;
	}

	alreadyWarned.push(name);

	// @ts-ignore
	process.emitWarning(message, {
		type: 'DeprecationWarning'
	});
};
