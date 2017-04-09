var util = require('util');
var extend = require('extend-object');
var BaseSession = require('jingle-session');
var RTCPeerConnection = require('rtcpeerconnection');

function filterContentSources(content, stream) {
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
            var found = false;
            for (var i = 0; i < content.application.sources.length; i++) {
                if (content.application.sources[i].ssrc === group.sources[0]) {
                    found = true;
                    break;
                }
            }
            return found;
        });
    }
}

function filterUnusedLabels(content) {
    // Remove mslabel and label ssrc-specific attributes
    var sources = content.application.sources || [];
    sources.forEach(function (source) {
        source.parameters = source.parameters.filter(function (parameter) {
            return !(parameter.key === 'mslabel' || parameter.key === 'label');
        });
    });
}


function MediaSession(opts) {
    BaseSession.call(this, opts);

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

    this._actions = [];
}


util.inherits(MediaSession, BaseSession);


Object.defineProperties(MediaSession.prototype, {
    ringing: {
        get: function () {
            return this._ringing;
        },
        set: function (value) {
            if (value !== this._ringing) {
                this._ringing = value;
                this.emit('change:ringing', value);
            }
        }
    },
    streams: {
        get: function () {
            if (this.pc.signalingState !== 'closed') {
                return this.pc.getRemoteStreams();
            }
            return [];
        }
    }
});


MediaSession.prototype = extend(MediaSession.prototype, {

  // ----------------------------------------------------------------
  // "Queue" for serializing async actions
  // ----------------------------------------------------------------

    _queue: function(action){
      var self = this;
      self._actions.push(action);
      if(self._actions.length > 1){
        return;
      }
      self._actNext();
    },

    _actNext: function(){
      var self = this;
      var next = self._actions[0];
      if(!next){
        return;
      }
      next(function(){
        self._actions.shift();
        self._actNext();
      });
    },

    // ----------------------------------------------------------------
    // Session control methods
    // ----------------------------------------------------------------

    _start: function (offerOptions, next, done) {
      var self = this;
      self.state = 'pending';

      next = next || function () {};

      self.pc.isInitiator = true;
      self.pc.offer(offerOptions, function (err, offer) {
          if (err) {
              self._log('error', 'Could not create WebRTC offer', err);
              self.end('failed-application', true);
              return done();
          }

          // a workaround for missing a=sendonly
          // https://code.google.com/p/webrtc/issues/detail?id=1553
          if (offerOptions && offerOptions.mandatory) {
              offer.jingle.contents.forEach(function (content) {
                  var mediaType = content.application.media;

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

          self.send('session-initiate', offer.jingle);
          next();
          done();
      });
    },

    start: function (offerOptions, next) {
        var self = this;
        self._queue(function(done){
          self._start(offerOptions, next, done);
        });
    },

    _accept: function (opts, next, done) {
        var self = this;
        self.constraints = opts.constraints || {
            mandatory: {
                OfferToReceiveAudio: true,
                OfferToReceiveVideo: true
            }
        };

        self._log('info', 'Accepted incoming session');

        self.state = 'active';

        self.pc.answer(self.constraints, function (err, answer) {
            if (err) {
                self._log('error', 'Could not create WebRTC answer', err);
                self.end('failed-application');
                return done();
            }

            answer.jingle.contents.forEach(filterUnusedLabels);

            self.send('session-accept', answer.jingle);

            next();
            done();
        });
    },

    accept: function (opts, next) {
        var self = this;

        // support calling with accept(next) or accept(opts, next)
        if (arguments.length === 1 && typeof opts === 'function') {
            next = opts;
            opts = {};
        }
        next = next || function () {};
        opts = opts || {};

        self._queue(function(done){
          self._accept(opts, next, done);
        });
    },

    _end: function (reason, silent, done) {
      var self = this;
      self.streams.forEach(function (stream) {
          self.onRemoveStream({stream: stream});
      });
      self.pc.close();
      BaseSession.prototype.end.call(self, reason, silent);
      done();
    },

    end: function (reason, silent) {
        var self = this;
        self._queue(function(done){
          self._end(reason, silent, done);
        });
    },

    _ring: function (done) {
        var self = this;
        self._log('info', 'Ringing on incoming session');
        self.ringing = true;
        self.send('session-info', {ringing: true});
        done();
    },

    ring: function () {
        var self = this;
        self._queue(function(done){
          self._ring(done);
        });
    },

    _mute: function (creator, name, done) {
        var self = this;
        self._log('info', 'Muting', name);

        self.send('session-info', {
            mute: {
                creator: creator,
                name: name
            }
        });
        done();
    },

    mute: function (creator, name) {
        var self = this;
        self._queue(function(done){
          self._mute(creator, name, done);
        });
    },

    _unmute: function (creator, name, done) {
        var self = this;
        self._log('info', 'Unmuting', name);
        self.send('session-info', {
            unmute: {
                creator: creator,
                name: name
            }
        });
        done();
    },

    unmute: function (creator, name) {
        var self = this;
        self._queue(function(done){
          self._unmute(creator, name, done);
        });
    },

    _hold: function (done) {
        var self = this;
        self._log('info', 'Placing on hold');
        self.send('session-info', {hold: true});
        done();
    },

    hold: function () {
        var self = this;
        self._queue(function(done){
          self._hold(done);
        });
    },

    _resume: function (done) {
        var self = this;
        self._log('info', 'Resuming from hold');
        self.send('session-info', {active: true});
        done();
    },

    resume: function () {
        var self = this;
        self._queue(function(done){
          self._resume(done);
        });
    },

    // ----------------------------------------------------------------
    // Stream control methods
    // ----------------------------------------------------------------

    _addStream: function (stream, renegotiate, cb, done) {
        var self = this;
        cb = cb || function () {};

        self.pc.addStream(stream);

        if (!renegotiate) {
            return done();
        } else if (typeof renegotiate === 'object') {
            self.constraints = renegotiate;
        }

        self.pc.handleOffer({
            type: 'offer',
            jingle: self.pc.remoteDescription
        }, function (err) {
            if (err) {
                self._log('error', 'Could not create offer for adding new stream');
                cb(err);
                return done();
            }
            self.pc.answer(self.constraints, function (err, answer) {
                if (err) {
                    self._log('error', 'Could not create answer for adding new stream');
                    cb(err);
                    return done();
                }
                answer.jingle.contents.forEach(function (content) {
                    filterContentSources(content, stream);
                });
                answer.jingle.contents = answer.jingle.contents.filter(function (content) {
                    return content.application.applicationType === 'rtp' && content.application.sources && content.application.sources.length;
                });
                delete answer.jingle.groups;

                self.send('source-add', answer.jingle);
                cb();
                done();
            });
        });
    },

    addStream: function (stream, renegotiate, cb) {
        var self = this;
        self._queue(function(done){
          self._addStream(stream, renegotiate, cb, done);
        });
    },

    addStream2: function (stream, cb) {
        this.addStream(stream, true, cb);
    },

    _removeStream: function (stream, renegotiate, cb, done) {
        var self = this;
        cb = cb || function () {};

        if (!renegotiate) {
            self.pc.removeStream(stream);
            return done();
        } else if (typeof renegotiate === 'object') {
            self.constraints = renegotiate;
        }

        var desc = self.pc.localDescription;
        desc.contents.forEach(function (content) {
            filterContentSources(content, stream);
        });
        desc.contents = desc.contents.filter(function (content) {
            return content.application.applicationType === 'rtp' && content.application.sources && content.application.sources.length;
        });
        delete desc.groups;

        self.send('source-remove', desc);
        self.pc.removeStream(stream);

        self.pc.handleOffer({
            type: 'offer',
            jingle: self.pc.remoteDescription
        }, function (err) {
            if (err) {
                self._log('error', 'Could not process offer for removing stream');
                cb(err);
                return done();
            }
            self.pc.answer(self.constraints, function (err) {
                if (err) {
                    self._log('error', 'Could not process answer for removing stream');
                    cb(err);
                    return done();
                }
                cb();
                done();
            });
        });
    },

    removeStream: function (stream, renegotiate, cb) {
        var self = this;
        self._queue(function(done){
          self._removeStream(stream, renegotiate, cb, done);
        });
    },

    removeStream2: function (stream, cb) {
        this.removeStream(stream, true, cb);
    },

    _switchStream: function (oldStream, newStream, cb, done) {
        var self = this;
        cb = cb || function () {};

        var desc = self.pc.localDescription;
        desc.contents.forEach(function (content) {
            delete content.transport;
            delete content.application.payloads;
        });

        self.pc.removeStream(oldStream);
        self.send('source-remove', desc);

        self.pc.addStream(newStream);
        self.pc.handleOffer({
            type: 'offer',
            jingle: self.pc.remoteDescription
        }, function (err) {
            if (err) {
                self._log('error', 'Could not process offer for switching streams');
                cb(err);
                return done();
            }
            self.pc.answer(self.constraints, function (err, answer) {
                if (err) {
                    self._log('error', 'Could not process answer for switching streams');
                    cb(err);
                    return done();
                }
                answer.jingle.contents.forEach(function (content) {
                    delete content.transport;
                    delete content.application.payloads;
                });
                self.send('source-add', answer.jingle);
                cb();
                done();
            });
        });
    },

    switchStream: function (oldStream, newStream, cb) {
        var self = this;
        self._queue(function(done){
          self._switchStream(oldStream, newStream, cb, done);
        });
    },

    // ----------------------------------------------------------------
    // ICE action handers
    // ----------------------------------------------------------------

    onIceCandidate: function (opts, candidate) {
        this._log('info', 'Discovered new ICE candidate', candidate.jingle);
        this.send('transport-info', candidate.jingle);
        if (opts.signalEndOfCandidates) {
            this.lastCandidate = candidate;
        }
    },

    onIceEndOfCandidates: function (opts) {
        this._log('info', 'ICE end of candidates');
        if (opts.signalEndOfCandidates) {
            var endOfCandidates = this.lastCandidate.jingle;
            endOfCandidates.contents[0].transport = {
                transportType: endOfCandidates.contents[0].transport.transportType,
                gatheringComplete: true
            };
            this.lastCandidate = null;
            this.send('transport-info', endOfCandidates);
        }
    },

    onIceStateChange: function () {
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
    },

    // ----------------------------------------------------------------
    // Stream event handlers
    // ----------------------------------------------------------------

    onAddStream: function (event) {
        this._log('info', 'Stream added');
        this.emit('peerStreamAdded', this, event.stream);
    },

    onRemoveStream: function (event) {
        this._log('info', 'Stream removed');
        this.emit('peerStreamRemoved', this, event.stream);
    },

    // ----------------------------------------------------------------
    // Jingle action handers
    // ----------------------------------------------------------------

    _onSessionInitiate: function (changes, cb, done) {
        var self = this;
        self._log('info', 'Initiating incoming session');

        self.state = 'pending';

        self.pc.isInitiator = false;
        self.pc.handleOffer({
            type: 'offer',
            jingle: changes
        }, function (err) {
            if (err) {
                self._log('error', 'Could not create WebRTC answer');
                cb({condition: 'general-error'});
                return done();
            }
            cb();
            done();
        });
    },

    onSessionInitiate: function (changes, cb) {
        var self = this;
        self._queue(function(done){
          self._onSessionInitiate(changes, cb, done);
        });
    },

    _onSessionAccept: function (changes, cb, done) {
        var self = this;
        self.state = 'active';
        self.pc.handleAnswer({
            type: 'answer',
            jingle: changes
        }, function (err) {
            if (err) {
                self._log('error', 'Could not process WebRTC answer');
                cb({condition: 'general-error'});
                return done();
            }
            self.emit('accepted', self);
            cb();
            done();
        });
    },

    onSessionAccept: function (changes, cb) {
        var self = this;
        self._queue(function(done){
          self._onSessionAccept(changes, cb, done);
        });
    },

    _onSessionTerminate: function (changes, cb, done) {
        var self = this;
        self._log('info', 'Terminating session');
        self.streams.forEach(function (stream) {
            self.onRemoveStream({stream: stream});
        });
        self.pc.close();
        BaseSession.prototype.end.call(self, changes.reason, true);

        cb();
        done();
    },

    onSessionTerminate: function (changes, cb) {
        var self = this;
        self._queue(function(done){
          self._onSessionTerminate(changes, cb, done);
        });
    },

    _onSessionInfo: function (info, cb, done) {
        var self = this;
        if (info.ringing) {
            self._log('info', 'Outgoing session is ringing');
            self.ringing = true;
            self.emit('ringing', self);
            cb();
            return done();
        }

        if (info.hold) {
            self._log('info', 'On hold');
            self.emit('hold', self);
            cb();
            return done();
        }

        if (info.active) {
            self._log('info', 'Resuming from hold');
            self.emit('resumed', self);
            cb();
            return done();
        }

        if (info.mute) {
            self._log('info', 'Muting', info.mute);
            self.emit('mute', self, info.mute);
            cb();
            return done();
        }

        if (info.unmute) {
            self._log('info', 'Unmuting', info.unmute);
            self.emit('unmute', self, info.unmute);
            cb();
            return done();
        }

        cb();
        done();
    },

    onSessionInfo: function (info, cb) {
        var self = this;
        self._queue(function(done){
          self._onSessionInfo(info, cb, done);
        });
    },

    _onTransportInfo: function (changes, cb, done) {
      var self = this;
      self.pc.processIce(changes, function () {
          cb();
          done();
      });
    },

    onTransportInfo: function (changes, cb) {
      var self = this;
      self._queue(function(done){
        self._onTransportInfo(changes, cb, done);
      });
    },

    _onSourceAdd: function (changes, cb, done) {
        var self = this;
        self._log('info', 'Adding new stream source');

        var newDesc = self.pc.remoteDescription;
        self.pc.remoteDescription.contents.forEach(function (content, idx) {
            var desc = content.application;
            var ssrcs = desc.sources || [];
            var groups = desc.sourceGroups || [];

            changes.contents.forEach(function (newContent) {
                if (content.name !== newContent.name) {
                    return;
                }

                var newContentDesc = newContent.application;
                var newSSRCs = newContentDesc.sources || [];

                ssrcs = ssrcs.concat(newSSRCs);
                newDesc.contents[idx].application.sources = JSON.parse(JSON.stringify(ssrcs));

                var newGroups = newContentDesc.sourceGroups || [];
                groups = groups.concat(newGroups);
                newDesc.contents[idx].application.sourceGroups = JSON.parse(JSON.stringify(groups));
            });
        });

        self.pc.handleOffer({
            type: 'offer',
            jingle: newDesc
        }, function (err) {
            if (err) {
                self._log('error', 'Error adding new stream source');
                cb({
                    condition: 'general-error'
                });
                return done();
            }

            self.pc.answer(self.constraints, function (err) {
                if (err) {
                    self._log('error', 'Error adding new stream source');
                    cb({
                        condition: 'general-error'
                    });
                    return done();
                }
                cb();
                done();
            });
        });
    },

    onSourceAdd: function (changes, cb) {
        var self = this;
        self._queue(function(done){
          self._onSourceAdd(changes, cb, done);
        });
    },

    _onSourceRemove: function (changes, cb, done) {
        var self = this;
        self._log('info', 'Removing stream source');

        var newDesc = self.pc.remoteDescription;
        self.pc.remoteDescription.contents.forEach(function (content, idx) {
            var desc = content.application;
            var ssrcs = desc.sources || [];
            var groups = desc.sourceGroups || [];

            changes.contents.forEach(function (newContent) {
                if (content.name !== newContent.name) {
                    return;
                }

                var newContentDesc = newContent.application;
                var newSSRCs = newContentDesc.sources || [];
                var newGroups = newContentDesc.sourceGroups || [];

                var found, i, j, k;


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
                            var same = true;
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

        self.pc.handleOffer({
            type: 'offer',
            jingle: newDesc
        }, function (err) {
            if (err) {
                self._log('error', 'Error removing stream source');
                cb({
                    condition: 'general-error'
                });
                return done();
            }
            self.pc.answer(self.constraints, function (err) {
                if (err) {
                    self._log('error', 'Error removing stream source');
                    cb({
                        condition: 'general-error'
                    });
                    return done();
                }
                cb();
                done();
            });
        });
    },

    onSourceRemove: function (changes, cb) {
        var self = this;
        self._queue(function(done){
          self._onSourceRemove(changes, cb, done);
        });
    },

    // ----------------------------------------------------------------
    // DataChannels
    // ----------------------------------------------------------------
    onAddChannel: function (channel) {
        this.emit('addChannel', channel);
    }
});


module.exports = MediaSession;
