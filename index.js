const BaseSession = require('jingle-session');
const RTCPeerConnection = require('rtcpeerconnection');

function filterContentSources (content, stream) {
  if (content.application.applicationType !== 'rtp') {
    return;
  }
  delete content.transport;
  delete content.application.payloads;
  delete content.application.headerExtensions;
  content.application.mux = false;

  if (content.application.sources) {
    content.application.sources = content.application.sources.filter(function (source) {
      return stream.id === source.parameters[1].value.split(' ')[0];
    });
  }

  // remove source groups not related to this stream
  if (content.application.sourceGroups) {
    content.application.sourceGroups = content.application.sourceGroups.filter(function (group) {
      let found = false;
      for (let i = 0; i < content.application.sources.length; i++) {
        if (content.application.sources[i].ssrc === group.sources[0]) {
          found = true;
          break;
        }
      }
      return found;
    });
  }
}

function filterUnusedLabels (content) {
  // Remove mslabel and label ssrc-specific attributes
  const sources = content.application.sources || [];
  sources.forEach(function (source) {
    source.parameters = source.parameters.filter(function (parameter) {
      return !(parameter.key === 'mslabel' || parameter.key === 'label');
    });
  });
}

class MediaSession extends BaseSession {
  constructor (opts) {
    super(opts);

    this.pc = new RTCPeerConnection({
      iceServers: opts.iceServers || [],
      useJingle: true
    }, opts.constraints || {});

    this.pc.on('ice', this.onIceCandidate.bind(this, opts));
    this.pc.on('endOfCandidates', this.onIceEndOfCandidates.bind(this, opts));
    this.pc.on('iceConnectionStateChange', this.onIceStateChange.bind(this));
    this.pc.on('addStream', this.onAddStream.bind(this));
    this.pc.on('removeStream', this.onRemoveStream.bind(this));
    this.pc.on('addChannel', this.onAddChannel.bind(this));

    if (opts.stream) {
      this.addStream(opts.stream);
    }

    this._ringing = false;
  }

  get ringing () {
    return this._ringing;
  }

  set ringing (value) {
    if (value !== this._ringing) {
      this._ringing = value;
      this.emit('change:ringing', value);
    }
  }

  get streams () {
    if (this.pc.signalingState !== 'closed') {
      return this.pc.getRemoteStreams();
    }
    return [];
  }

  // ----------------------------------------------------------------
  // Session control methods
  // ----------------------------------------------------------------

  start (offerOptions, next) {
    this.state = 'pending';

    next = next || function () {};

    this.pc.isInitiator = true;
    this.pc.offer(offerOptions, (err, offer) => {
      if (err) {
        this._log('error', 'Could not create WebRTC offer', err);
        return this.end('failed-application', true);
      }

      // a workaround for missing a=sendonly
      // https://code.google.com/p/webrtc/issues/detail?id=1553
      if (offerOptions && offerOptions.mandatory) {
        offer.jingle.contents.forEach(function (content) {
          const mediaType = content.application.media;

          if (!content.description || content.application.applicationType !== 'rtp') {
            return;
          }

          if (!offerOptions.mandatory.OfferToReceiveAudio && mediaType === 'audio') {
            content.senders = 'initiator';
          }

          if (!offerOptions.mandatory.OfferToReceiveVideo && mediaType === 'video') {
            content.senders = 'initiator';
          }
        });
      }

      offer.jingle.contents.forEach(filterUnusedLabels);

      this.send('session-initiate', offer.jingle);

      next();
    });
  }

  accept (opts, next) {
    // support calling with accept(next) or accept(opts, next)
    if (arguments.length === 1 && typeof opts === 'function') {
      next = opts;
      opts = {};
    }
    next = next || function () {};
    opts = opts || {};

    this.constraints = opts.constraints || {
      mandatory: {
        OfferToReceiveAudio: true,
        OfferToReceiveVideo: true
      }
    };

    this._log('info', 'Accepted incoming session');

    this.state = 'active';

    this.pc.answer(this.constraints, (err, answer) => {
      if (err) {
        this._log('error', 'Could not create WebRTC answer', err);
        return this.end('failed-application');
      }

      answer.jingle.contents.forEach(filterUnusedLabels);

      this.send('session-accept', answer.jingle);

      next();
    });
  }

  end (reason, silent) {
    this.streams.forEach((stream) => {
      this.onRemoveStream({stream: stream});
    });
    this.pc.close();
    super.end(reason, silent);
  }

  ring () {
    this._log('info', 'Ringing on incoming session');
    this.ringing = true;
    this.send('session-info', { ringing: true });
  }

  mute (creator, name) {
    this._log('info', 'Muting', name);

    this.send('session-info', {
      mute: {
        creator: creator,
        name: name
      }
    });
  }

  unmute (creator, name) {
    this._log('info', 'Unmuting', name);
    this.send('session-info', {
      unmute: {
        creator: creator,
        name: name
      }
    });
  }

  hold () {
    this._log('info', 'Placing on hold');
    this.send('session-info', { hold: true });
  }

  resume () {
    this._log('info', 'Resuming from hold');
    this.send('session-info', {active: true});
  }

  // ----------------------------------------------------------------
  // Stream control methods
  // ----------------------------------------------------------------

  addStream (stream, renegotiate, cb) {
    cb = cb || function () {};

    this.pc.addStream(stream);

    if (!renegotiate) {
      return;
    }

    if (typeof renegotiate === 'object') {
      this.constraints = renegotiate;
    }

    this.pc.handleOffer({
      type: 'offer',
      jingle: this.pc.remoteDescription
    }, (err) => {
      if (err) {
        this._log('error', 'Could not create offer for adding new stream');
        return cb(err);
      }
      this.pc.answer(this.constraints, (err, answer) => {
        if (err) {
          this._log('error', 'Could not create answer for adding new stream');
          return cb(err);
        }
        answer.jingle.contents.forEach(function (content) {
          filterContentSources(content, stream);
        });
        answer.jingle.contents = answer.jingle.contents.filter(function (content) {
          return content.application.applicationType === 'rtp' && content.application.sources && content.application.sources.length;
        });
        delete answer.jingle.groups;

        this.send('source-add', answer.jingle);
        cb();
      });
    });
  }

  addStream2 (stream, cb) {
    this.addStream(stream, true, cb);
  }

  removeStream (stream, renegotiate, cb) {
    cb = cb || function () {};

    if (!renegotiate) {
      this.pc.removeStream(stream);
      return;
    }
    if (typeof renegotiate === 'object') {
      this.constraints = renegotiate;
    }

    const desc = this.pc.localDescription;
    desc.contents.forEach(function (content) {
      filterContentSources(content, stream);
    });
    desc.contents = desc.contents.filter(function (content) {
      return content.application.applicationType === 'rtp' && content.application.sources && content.application.sources.length;
    });
    delete desc.groups;

    this.send('source-remove', desc);
    this.pc.removeStream(stream);

    this.pc.handleOffer({
      type: 'offer',
      jingle: this.pc.remoteDescription
    }, (err) => {
      if (err) {
        this._log('error', 'Could not process offer for removing stream');
        return cb(err);
      }
      this.pc.answer(this.constraints, (err) => {
        if (err) {
          this._log('error', 'Could not process answer for removing stream');
          return cb(err);
        }
        cb();
      });
    });
  }

  removeStream2 (stream, cb) {
    this.removeStream(stream, true, cb);
  }

  switchStream (oldStream, newStream, cb) {
    cb = cb || function () {};

    const desc = this.pc.localDescription;
    desc.contents.forEach(function (content) {
      delete content.transport;
      delete content.application.payloads;
    });

    this.pc.removeStream(oldStream);
    this.send('source-remove', desc);

    this.pc.addStream(newStream);
    this.pc.handleOffer({
      type: 'offer',
      jingle: this.pc.remoteDescription
    }, (err) => {
      if (err) {
        this._log('error', 'Could not process offer for switching streams');
        return cb(err);
      }
      this.pc.answer(this.constraints, (err, answer) => {
        if (err) {
          this._log('error', 'Could not process answer for switching streams');
          return cb(err);
        }
        answer.jingle.contents.forEach(function (content) {
          delete content.transport;
          delete content.application.payloads;
        });
        this.send('source-add', answer.jingle);
        cb();
      });
    });
  }

  // ----------------------------------------------------------------
  // ICE action handers
  // ----------------------------------------------------------------

  onIceCandidate (opts, candidate) {
    this._log('info', 'Discovered new ICE candidate', candidate.jingle);
    this.send('transport-info', candidate.jingle);
    if (opts.signalEndOfCandidates) {
      this.lastCandidate = candidate;
    }
  }

  onIceEndOfCandidates (opts) {
    this._log('info', 'ICE end of candidates');
    if (opts.signalEndOfCandidates) {
      const endOfCandidates = this.lastCandidate.jingle;
      endOfCandidates.contents[0].transport = {
        transportType: endOfCandidates.contents[0].transport.transportType,
        gatheringComplete: true
      };
      this.lastCandidate = null;
      this.send('transport-info', endOfCandidates);
    }
  }

  onIceStateChange () {
    switch (this.pc.iceConnectionState) {
      case 'checking':
        this.connectionState = 'connecting';
        break;
      case 'completed':
      case 'connected':
        this.connectionState = 'connected';
        break;
      case 'disconnected':
        if (this.pc.signalingState === 'stable') {
          this.connectionState = 'interrupted';
        } else {
          this.connectionState = 'disconnected';
        }
        break;
      case 'failed':
        this.connectionState = 'failed';
        this.end('failed-transport');
        break;
      case 'closed':
        this.connectionState = 'disconnected';
        break;
    }
  }

  // ----------------------------------------------------------------
  // Stream event handlers
  // ----------------------------------------------------------------

  onAddStream (event) {
    this._log('info', 'Stream added');
    this.emit('peerStreamAdded', this, event.stream);
  }

  onRemoveStream (event) {
    this._log('info', 'Stream removed');
    this.emit('peerStreamRemoved', this, event.stream);
  }

  // ----------------------------------------------------------------
  // Jingle action handers
  // ----------------------------------------------------------------

  onSessionInitiate (changes, cb) {
    this._log('info', 'Initiating incoming session');

    this.state = 'pending';

    this.pc.isInitiator = false;
    this.pc.handleOffer({ type: 'offer', jingle: changes }, (err) => {
      if (err) {
        this._log('error', 'Could not create WebRTC answer');
        return cb({condition: 'general-error'});
      }
      cb();
    });
  }

  onSessionAccept (changes, cb) {
    this.state = 'active';
    this.pc.handleAnswer({ type: 'answer', jingle: changes }, (err) => {
      if (err) {
        this._log('error', 'Could not process WebRTC answer');
        return cb({condition: 'general-error'});
      }
      this.emit('accepted', this);
      cb();
    });
  }

  onSessionTerminate (changes, cb) {
    this._log('info', 'Terminating session');
    this.streams.forEach((stream) => {
      this.onRemoveStream({ stream });
    });
    this.pc.close();
    BaseSession.prototype.end.call(this, changes.reason, true);

    cb();
  }

  onSessionInfo (info, cb) {
    if (info.ringing) {
      this._log('info', 'Outgoing session is ringing');
      this.ringing = true;
      this.emit('ringing', this);
      return cb();
    }

    if (info.hold) {
      this._log('info', 'On hold');
      this.emit('hold', this);
      return cb();
    }

    if (info.active) {
      this._log('info', 'Resuming from hold');
      this.emit('resumed', this);
      return cb();
    }

    if (info.mute) {
      this._log('info', 'Muting', info.mute);
      this.emit('mute', this, info.mute);
      return cb();
    }

    if (info.unmute) {
      this._log('info', 'Unmuting', info.unmute);
      this.emit('unmute', this, info.unmute);
      return cb();
    }

    cb();
  }

  onTransportInfo (changes, cb) {
    this.pc.processIce(changes, function () {
      cb();
    });
  }

  onSourceAdd (changes, cb) {
    this._log('info', 'Adding new stream source');

    const newDesc = this.pc.remoteDescription;
    this.pc.remoteDescription.contents.forEach(function (content, idx) {
      const desc = content.application;
      let ssrcs = desc.sources || [];
      let groups = desc.sourceGroups || [];

      changes.contents.forEach(function (newContent) {
        if (content.name !== newContent.name) {
          return;
        }

        const newContentDesc = newContent.application;
        const newSSRCs = newContentDesc.sources || [];

        ssrcs = ssrcs.concat(newSSRCs);
        newDesc.contents[idx].application.sources = JSON.parse(JSON.stringify(ssrcs));

        const newGroups = newContentDesc.sourceGroups || [];
        groups = groups.concat(newGroups);
        newDesc.contents[idx].application.sourceGroups = JSON.parse(JSON.stringify(groups));
      });
    });

    this.pc.handleOffer({ type: 'offer', jingle: newDesc }, function (err) {
      if (err) {
        this._log('error', 'Error adding new stream source');
        return cb({
          condition: 'general-error'
        });
      }

      this.pc.answer(this.constraints, (err) => {
        if (err) {
          this._log('error', 'Error adding new stream source');
          return cb({
            condition: 'general-error'
          });
        }
        cb();
      });
    });
  }

  onSourceRemove (changes, cb) {
    this._log('info', 'Removing stream source');

    const newDesc = this.pc.remoteDescription;
    this.pc.remoteDescription.contents.forEach(function (content, idx) {
      const desc = content.application;
      let ssrcs = desc.sources || [];
      let groups = desc.sourceGroups || [];

      changes.contents.forEach(function (newContent) {
        if (content.name !== newContent.name) {
          return;
        }

        const newContentDesc = newContent.application;
        const newSSRCs = newContentDesc.sources || [];
        const newGroups = newContentDesc.sourceGroups || [];

        let found, i, j, k;
        for (i = 0; i < newSSRCs.length; i++) {
          found = -1;
          for (j = 0; j < ssrcs.length; j++) {
            if (newSSRCs[i].ssrc === ssrcs[j].ssrc) {
              found = j;
              break;
            }
          }
          if (found > -1) {
            ssrcs.splice(found, 1);
            newDesc.contents[idx].application.sources = JSON.parse(JSON.stringify(ssrcs));
          }
        }

        // Remove ssrc-groups that are no longer needed
        for (i = 0; i < newGroups.length; i++) {
          found = -1;
          for (j = 0; j < groups.length; j++) {
            if (newGroups[i].semantics === groups[j].semantics &&
                newGroups[i].sources.length === groups[j].sources.length) {
              let same = true;
              for (k = 0; k < newGroups[i].sources.length; k++) {
                if (newGroups[i].sources[k] !== groups[j].sources[k]) {
                  same = false;
                  break;
                }
              }
              if (same) {
                found = j;
                break;
              }
            }
          }
          if (found > -1) {
            groups.splice(found, 1);
            newDesc.contents[idx].application.sourceGroups = JSON.parse(JSON.stringify(groups));
          }
        }
      });
    });

    this.pc.handleOffer({ type: 'offer', jingle: newDesc }, (err) => {
      if (err) {
        this._log('error', 'Error removing stream source');
        return cb({
          condition: 'general-error'
        });
      }
      this.pc.answer(this.constraints, (err) => {
        if (err) {
          this._log('error', 'Error removing stream source');
          return cb({
            condition: 'general-error'
          });
        }
        cb();
      });
    });
  }

  // ----------------------------------------------------------------
  // DataChannels
  // ----------------------------------------------------------------
  onAddChannel (channel) {
    this.emit('addChannel', channel);
  }
}

module.exports = MediaSession;
