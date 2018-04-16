import test from 'ava';
import got from '..';

test.serial('Clear the progressInterval if the socket has been destroyed', async t => {
	// There are 2 handles at this point
	// const handleCount = process._getActiveHandles().length;

	const err = await t.throws(got(`http://127.0.0.1:55555/`, {retry: 0}));
	// Without the code from #469 there are 5 handles here. With #469's changes
	// there are 4 handles. I can't figure out where the other two handles are
	// getting creacted, so the best I can do is hard-code this 4 and hope someone
	// else can figure out a better solution.
	t.is(process._getActiveHandles().length, 4);
	t.is(err.code, 'ECONNREFUSED');
});
