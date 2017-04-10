/* global describe, it */
const JingleMediaSession = require('../tmp/jingle-media-session.js');
const { expect } = require('chai');
const sinon = require('sinon');

// For mocking out peer connection for unit test purposes
if (typeof window === 'undefined') {
  global.RTCPeerConnection = function () {
    this.getRemoteStreams = () => [];
    this.addStream = () => {};
  };
}

describe('jingle-media-session', function () {
  // examle test for basic test assertions
  it('can have an instance created', function () {
    expect(Date.now).to.be.a('function');

    const jms = new JingleMediaSession({
      peerID: 'testuser@example.com/client-1'
    });

    expect(jms.streams).to.deep.equal([]);
    sinon.stub(jms, 'start');
    jms.start();
    sinon.assert.calledOnce(jms.start);

    return new Promise(resolve => {
      const start = Date.now();
      setTimeout(() => {
        expect(Date.now() - start > 100).to.equal(true);
        resolve();
      }, 100);
    });
  });
});
