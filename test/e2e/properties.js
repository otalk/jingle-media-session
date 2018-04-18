const MediaSession = require('../../index.js');

describe('MediaSession', () => {
    it('has a peerconnection property named pc', () => {
        const session = new MediaSession({
            sid: '123',
            peer: 'some-peer',
            initiator: true,
        });
        expect(session).to.have.property('pc');
    });
});
