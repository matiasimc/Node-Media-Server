/**
 * @author [Mingliang Chen]
 * @email [illuspas@gmail.com]
 * @create date 2019-01-20 08:10:08
 * @modify date 2019-01-20 08:10:08
 * @desc [description]
 */

const FLV = require('./node_flv_format');
const Logger = require('./node_core_logger');
const NodeBaseSession = require('./node_base_session');

class NodeFlvSession extends NodeBaseSession {
  constructor(ctx, req, res) {
    super(req);
    this.ip = req.socket.remoteAddress; //.replace(/^.*:/, '');
    this.evt = ctx.evt;
    this.cfg = ctx.cfg;
    this.ses = ctx.ses;
    this.pbs = ctx.pbs;
    this.idl = ctx.idl;
    this.req = req;
    this.res = res;
    this.tag = '';
    this.streamApp = req.params.app;
    this.streamName = req.params.name;
    this.streamPath = `/${req.params.app}/${req.params.name}`;
    this.streamQuery = this.req.query;
    this.isReject = false;
    this.isStart = false;
    this.isLocal = this.ip === '127.0.0.1';
    this.isWebSocket = res.constructor.name === 'WebSocket';
    this.isRecord = res.constructor.name === 'WriteStream';
    this.isRelay = req.headers['connect-type'] === 'nms-relay' && this.isLocal;
    this.isIdle = false;
    this.isPlay = this.req.method === 'GET';
    this.isPublish = this.req.method === 'POST';
    this.numPlayCache = 0;
    this.hasAudio = true;
    this.hasVideo = true;
    this.ses.set(this.id, this);
  }

  run(next) {
    this.next = next;
    this.isStart = true;
    if (this.isWebSocket) {
      this.tag = 'ws-flv';
      this.res.write = this.res.send;
      this.res.end = this.res.close;
      this.res.cork = this.res.socket.cork.bind(this.res.socket);
      this.res.uncork = this.res.socket.uncork.bind(this.res.socket);
      this.res.once('close', this.stop.bind(this));
      this.res.once('error', this.stop.bind(this));
    } else if (this.isRecord) {
      this.tag = 'file-flv';
    } else {
      this.tag = 'http-flv';
      this.res.useChunkedEncodingByDefault = !!this.cfg.http.chunked_encoding;
      this.res.cork = this.res.socket.cork.bind(this.res.socket);
      this.res.uncork = this.res.socket.uncork.bind(this.res.socket);
      this.req.once('close', this.stop.bind(this));
      this.req.once('error', this.stop.bind(this));
    }
    this.eventArg = { ip: this.ip, tag: this.tag, streamPath: this.streamPath, streamApp: this.streamApp, streamName: this.streamName, streamQuery: this.streamQuery,  path: this.res.path };
    this.emit('preConnect', this.id, this.eventArg);
    if (this.isReject) {
      return this.stop();
    }
    this.emit('postConnect', this.id, this.eventArg);
    if (this.isPlay) {
      //play session
      Logger.log(`New Player id=${this.id} ip=${this.ip} stream_path=${this.streamPath} query=${JSON.stringify(this.streamQuery)} via=${this.tag}`);
      this.handlePlay();
    } else if (this.isPublish) {
      //publish session
      Logger.log(`New Publisher id=${this.id} ip=${this.ip} stream_path=${this.streamPath} query=${JSON.stringify(this.streamQuery)} via=${this.tag}`);
      this.handlePublish();
    } else {
      //other
    }
  }

  reject() {
    this.isReject = true;
  }

  stop() {
    if (this.isStart) {
      this.isStart = false;
      this.res.end();

      if (this.isPlay) {
        this.stopIdle();
        let publisherId = this.pbs.get(this.streamPath);
        let publiser = this.ses.get(publisherId);
        if (publiser) {
          publiser.players.delete(this.id);
        }
        this.emit('donePlay', this.id, this.eventArg);
        Logger.log(`Close Player id=${this.id}`);
      }

      if (this.isPublish) {
        this.stopStream();

        if (this.players) {
          for (let playerId of this.players) {
            let player = this.ses.get(playerId);
            player.stop();
          }
          this.pbs.delete(this.streamPath);

          this.players.clear();
          this.players = undefined;
        }

        this.clearGopCache();

        this.emit('donePublish', this.id, this.eventArg);
        Logger.log(`Close Publisher id=${this.id}`);
      }

      if (this.next) {
        this.next();
      }

      this.ses.delete(this.id);
      this.emit('doneConnect', this.id, this.eventArg);
    }
  }

  async handlePlay() {
    try {
      this.emit('prePlay', this.id, this.eventArg);
      if (this.isReject) {
        return this.stop();
      }

      if (!this.pbs.has(this.streamPath)) {
        this.isIdle = true;
        this.idl.add(this.id);
        Logger.log(`Idle Player id=${this.id}`);
        await this.waitIdle();
        this.idl.delete(this.id);
        this.isIdle = false;
      }

      if (this.pbs.has(this.streamPath)) {
        let publisherId = this.pbs.get(this.streamPath);
        let publiser = this.ses.get(publisherId);
        publiser.players.add(this.id);

        Logger.debug(`Info Player id=${this.id}`);
        this.emit('postPlay', this.id, this.eventArg);
        this.res.write(FLV.NodeFlvMuxer.createFlvHeader(publiser.hasAudio, publiser.hasVideo));

        if (publiser.flvDemuxer.metaData) {
          this.res.write(FLV.NodeFlvMuxer.createFlvTag(18, 0, publiser.flvDemuxer.metaData));
        }
        if (publiser.flvDemuxer.aacSequenceHeader) {
          this.res.write(FLV.NodeFlvMuxer.createFlvTag(8, 0, publiser.flvDemuxer.aacSequenceHeader));
        }
        if (publiser.flvDemuxer.avcSequenceHeader) {
          this.res.write(FLV.NodeFlvMuxer.createFlvTag(9, 0, publiser.flvDemuxer.avcSequenceHeader));
        }
        if (publiser.flvGopCacheQueue) {
          for (let chunk of publiser.flvGopCacheQueue) {
            this.res.write(chunk);
          }
        }
        Logger.log(`Start Player id=${this.id}`);
        await this.waitIdle();
      }
    } catch (error) {
      Logger.log(`Error Player id=${this.id} ${error}`);
    }
    this.stop();
  }

  emit(env, id, arg) {
    if (!this.isRelay) {
      this.evt.emit(env, id, arg);
    }
  }

  async handlePublish() {
    try {
      this.emit('prePublish', this.id, this.eventArg);
      if (this.isReject) {
        return this.stop();
      }

      if (this.pbs.has(this.streamPath)) {
        throw 'Already has a stream publish to ' + this.streamPath;
      }

      let flvHeader = await this.readStream(13);
      if (flvHeader.readUIntBE(0, 3) != 4607062) {
        throw 'Not a flv stream';
      }

      this.pbs.set(this.streamPath, this.id);
      this.players = new Set();
      this.flvDemuxer = new FLV.NodeFlvDemuxer();
      this.flvDemuxer.on('audio', this.onAudioData.bind(this));
      this.flvDemuxer.on('video', this.onVideoData.bind(this));
      this.flvDemuxer.on('script', this.onScriptData.bind(this));
      this.hasAudio = (flvHeader[4] & 0x4) >> 2;
      this.hasVideo = flvHeader[4] & 0x1;

      for (let idleId of this.idl) {
        let player = this.ses.get(idleId);
        if(player.streamPath === this.streamPath) {
          player.stopIdle();
        }
      }
      this.emit('postPublish', this.id, this.eventArg);
      Logger.log(`Start Publisher id=${this.id}`);
      while (this.isStart) {
        let tagHeader = await this.readStream(11);
        let tagType = tagHeader.readUInt8();
        let tagSize = tagHeader.readUIntBE(1, 3);
        let tagTime = tagHeader.readUIntBE(4, 3) | (tagHeader.readUInt8(7) << 24);
        let tagBody = await this.readStream(tagSize);
        let previousTagSize = await this.readStream(4);
        if (previousTagSize.readUInt32BE() - 11 != tagSize) {
          throw 'Flv tag parser error';
        }
        this.flvDemuxer.parseFlvTag(tagType, tagTime, tagBody);
      }
    } catch (error) {
      if (error !== 'stopStream') {
        Logger.log(`Error Publisher id=${this.id} ${error}`);
      }
    }

    this.stop();
  }

  
}

module.exports = NodeFlvSession;
