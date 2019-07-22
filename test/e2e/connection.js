const MediaSession = require('../../index.js');

function noop() {}

const types = [{audio: true}, {video: true}, {audio: true, video: true}];
types.forEach((type) => {
    let description;
    if (type.audio && type.video) {
        description = 'audio/video';
    } else if (type.audio) {
        description = 'audio-only';
    } else {
        description = 'video-only';
    }

    describe('establishment of a', () => {
        let localStream;
        beforeEach(() => {
            return navigator.mediaDevices.getUserMedia(type)
                .then((stream) => localStream = stream);
        });

        it(description + ' session', (done) => {
            const sessionA = new MediaSession({
                sid: '123',
                peer: 'some-peer',
                initiator: true,
            });
            const sessionB = new MediaSession({
                sid: '123',
                peer: 'some-peer',
                initiator: false,
            });

            sessionA.on('send', (data) => {
                sessionB.process(data.jingle.action, data.jingle, (err) => {
                    if (data.jingle.action === 'session-initiate' && !err) {
                        sessionB.accept(noop);
                    }
                });
            });
            sessionB.on('send', (data) => {
                sessionA.process(data.jingle.action, data.jingle, noop);
            });
            sessionA.on('change:connectionState', (session, state) => {
                if (state === 'connected') {
                    done();
                }
            });

            sessionA.addStream(localStream);
            sessionA.start({});
        });
    });
});
