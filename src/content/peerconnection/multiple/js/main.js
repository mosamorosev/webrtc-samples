/*
 *  Copyright (c) 2015 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */

'use strict';

const startButton = document.getElementById('startButton');
const callButton = document.getElementById('callButton');
const hangupButton = document.getElementById('hangupButton');
const videoCountInput = document.getElementById('videoCountInput');
const videoCodecSelect = document.getElementById('videoCodecSelect');
const remoteVideosDiv = document.getElementById('remoteVideos');
const statusDiv = document.getElementById('status');
callButton.disabled = true;
hangupButton.disabled = true;
startButton.onclick = start;
callButton.onclick = call;
hangupButton.onclick = hangup;

const video1 = document.querySelector('video#video1');

let preferredVideoCodecMimeType;

let localStream;
// peerPairs holds at most one entry: [{senderPc, receiverPc}].
// One senderPc encodes the local stream via N video transceivers;
// one receiverPc decodes all N incoming streams.
let peerPairs = [];
let remoteVideos = [];
let codecLabels = [];
let connectionStates = [];
let statsIntervalId = null;

const supportsSetCodecPreferences = window.RTCRtpTransceiver &&
  'setCodecPreferences' in window.RTCRtpTransceiver.prototype;
initCodecSelect();
videoCodecSelect.onchange = () => {
  preferredVideoCodecMimeType = videoCodecSelect.value;
};

function initCodecSelect() {
  const codecMimeTypes = getSupportedVideoCodecMimeTypes();
  videoCodecSelect.textContent = '';
  if (codecMimeTypes.length === 0) {
    videoCodecSelect.disabled = true;
    preferredVideoCodecMimeType = undefined;
    return;
  }
  codecMimeTypes.forEach(mimeType => {
    const option = document.createElement('option');
    option.value = mimeType;
    option.textContent = mimeType;
    videoCodecSelect.appendChild(option);
  });
  const h264MimeType = codecMimeTypes.find(mimeType => mimeType.toLowerCase() === 'video/h264');
  preferredVideoCodecMimeType = h264MimeType || codecMimeTypes[0];
  videoCodecSelect.value = preferredVideoCodecMimeType;
}

function getSupportedVideoCodecMimeTypes() {
  if (!window.RTCRtpSender || !RTCRtpSender.getCapabilities) {
    return [];
  }
  const capabilities = RTCRtpSender.getCapabilities('video');
  if (!capabilities || !capabilities.codecs) {
    return [];
  }
  const seen = new Set();
  return capabilities.codecs
      .map(codec => codec.mimeType)
      .filter(mimeType => {
        if (!mimeType) return false;
        const normalizedMimeType = mimeType.toLowerCase();
        if (normalizedMimeType === 'video/rtx' ||
            normalizedMimeType === 'video/red' ||
            normalizedMimeType === 'video/ulpfec' ||
            normalizedMimeType === 'video/flexfec-03') {
          return false;
        }
        if (seen.has(normalizedMimeType)) return false;
        seen.add(normalizedMimeType);
        return true;
      });
}

function applyCodecPreferences(transceiver, displayIndex) {
  if (!supportsSetCodecPreferences || !preferredVideoCodecMimeType) {
    return;
  }
  const capabilities = RTCRtpSender.getCapabilities('video');
  if (!capabilities || !capabilities.codecs) {
    return;
  }
  const codecs = capabilities.codecs.slice();
  const selectedCodecIndex = codecs.findIndex(codec =>
    codec.mimeType &&
    codec.mimeType.toLowerCase() === preferredVideoCodecMimeType.toLowerCase());
  if (selectedCodecIndex < 0) {
    return;
  }
  const selectedCodec = codecs[selectedCodecIndex];
  codecs.splice(selectedCodecIndex, 1);
  codecs.unshift(selectedCodec);
  transceiver.setCodecPreferences(codecs);
  console.log(`transceiver${displayIndex}: preferred video codec ${preferredVideoCodecMimeType}`);
}

async function start() {
  console.log('Requesting local stream');
  startButton.disabled = true;
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true
  });
  video1.srcObject = localStream;
  callButton.disabled = false;
}

async function call() {
  callButton.disabled = true;
  hangupButton.disabled = false;
  videoCountInput.disabled = true;
  videoCodecSelect.disabled = true;
  const receiveVideoCount = getRequestedVideoCount();
  console.log(`Setting up ${receiveVideoCount} receive video(s)`);
  const audioTracks = localStream.getAudioTracks();
  const videoTracks = localStream.getVideoTracks();
  if (audioTracks.length > 0) {
    console.log(`Using audio device: ${audioTracks[0].label}`);
  }
  if (videoTracks.length > 0) {
    console.log(`Using video device: ${videoTracks[0].label}`);
  }

  resetRemoteVideos(receiveVideoCount);
  connectionStates = new Array(receiveVideoCount).fill('new');
  updateStatus();

  // One senderPc encodes the local stream; one receiverPc decodes all N streams.
  const senderPc = new RTCPeerConnection();
  const receiverPc = new RTCPeerConnection();

  senderPc.onicecandidate = e => {
    if (e.candidate) {
      receiverPc.addIceCandidate(e.candidate).catch(err => {
        console.warn('receiverPc.addIceCandidate failed', err);
      });
    }
  };
  receiverPc.onicecandidate = e => {
    if (e.candidate) {
      senderPc.addIceCandidate(e.candidate).catch(err => {
        console.warn('senderPc.addIceCandidate failed', err);
      });
    }
  };

  receiverPc.onconnectionstatechange = () => {
    const state = receiverPc.connectionState;
    connectionStates = new Array(receiveVideoCount).fill(state);
    console.log(`connection state: ${state}`);
    updateStatus();
  };

  const videoTrack = videoTracks[0];
  const audioTrack = audioTracks[0];

  // Add N (video + audio) transceiver pairs to senderPc — one pair per receive view.
  // Each pair shares a distinct MediaStream so the receiver delivers them independently.
  const videoTransceivers = [];
  for (let i = 0; i < receiveVideoCount; i++) {
    const stream = new MediaStream(
        [videoTrack, audioTrack].filter(Boolean));
    const videoTransceiver = senderPc.addTransceiver(videoTrack, {
      direction: 'sendonly',
      streams: [stream]
    });
    videoTransceivers.push(videoTransceiver);
    if (audioTrack) {
      senderPc.addTransceiver(audioTrack, {
        direction: 'sendonly',
        streams: [stream]
      });
    }
  }

  videoTransceivers.forEach((t, i) => applyCodecPreferences(t, i + 1));
  console.log('senderPc: created with', receiveVideoCount, 'video transceiver(s)');

  // Generate the offer so transceiver mids are assigned before ontrack fires.
  await senderPc.setLocalDescription();

  // Map each video transceiver's mid to a remote-video index.
  const midToVideoIndex = new Map();
  senderPc.getTransceivers()
      .filter(t => t.sender.track && t.sender.track.kind === 'video')
      .forEach((t, idx) => {
        if (t.mid !== null) midToVideoIndex.set(t.mid, idx);
      });

  // Assign each incoming video track to its corresponding video element.
  receiverPc.ontrack = e => {
    if (e.track.kind !== 'video') return;
    const idx = midToVideoIndex.get(e.transceiver.mid);
    if (idx === undefined || !remoteVideos[idx]) return;
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (remoteVideos[idx].srcObject !== stream) {
      remoteVideos[idx].srcObject = stream;
      console.log(`video${idx + 1}: received remote stream (mid=${e.transceiver.mid})`);
    }
  };

  await receiverPc.setRemoteDescription(senderPc.localDescription);
  await receiverPc.setLocalDescription();
  await senderPc.setRemoteDescription(receiverPc.localDescription);
  console.log('negotiation completed');

  peerPairs = [{senderPc, receiverPc}];
  startStatsPolling(senderPc, receiverPc, midToVideoIndex);
  updateStatus();
}

function startStatsPolling(senderPc, receiverPc, midToVideoIndex) {
  stopStatsPolling();
  statsIntervalId = setInterval(() => {
    updateCodecLabels(senderPc, receiverPc, midToVideoIndex);
  }, 1500);
}

function stopStatsPolling() {
  if (statsIntervalId !== null) {
    clearInterval(statsIntervalId);
    statsIntervalId = null;
  }
}

async function updateCodecLabels(senderPc, receiverPc, midToVideoIndex) {
  const encoderByMid = new Map();
  try {
    const stats = await senderPc.getStats();
    stats.forEach(s => {
      if (s.type === 'outbound-rtp' && s.kind === 'video' && s.mid != null) {
        encoderByMid.set(s.mid, {impl: s.encoderImplementation, hw: s.powerEfficientEncoder});
      }
    });
  } catch (_) {
    // PC may be closing
  }

  const decoderByMid = new Map();
  try {
    const stats = await receiverPc.getStats();
    stats.forEach(s => {
      if (s.type === 'inbound-rtp' && s.kind === 'video' && s.mid != null) {
        decoderByMid.set(s.mid, {impl: s.decoderImplementation, hw: s.powerEfficientDecoder});
      }
    });
  } catch (_) {
    // PC may be closing
  }

  for (const [mid, idx] of midToVideoIndex) {
    if (idx >= codecLabels.length) continue;
    const parts = [
      formatCodecInfo('Enc', encoderByMid.get(mid)),
      formatCodecInfo('Dec', decoderByMid.get(mid))
    ].filter(Boolean);
    codecLabels[idx].textContent = parts.length ? parts.join(' | ') : '-';
  }
}

function formatCodecInfo(prefix, info) {
  if (!info || !info.impl) return '';
  const hw = info.hw === true ? ' (HW)' : info.hw === false ? ' (SW)' : '';
  return `${prefix}: ${info.impl}${hw}`;
}

function hangup() {
  console.log('Ending call');
  stopStatsPolling();
  peerPairs.forEach(pair => {
    pair.senderPc.close();
    pair.receiverPc.close();
  });
  peerPairs = [];
  resetRemoteVideos(0);
  connectionStates = [];
  statusDiv.textContent = '';
  hangupButton.disabled = true;
  callButton.disabled = false;
  videoCountInput.disabled = false;
  videoCodecSelect.disabled = false;
}

function getRequestedVideoCount() {
  const min = Number(videoCountInput.min) || 1;
  const max = Number(videoCountInput.max) || 16;
  const parsed = Number(videoCountInput.value);
  const safeValue = Number.isFinite(parsed) ? parsed : 2;
  return Math.max(min, Math.min(max, Math.trunc(safeValue)));
}

function resetRemoteVideos(count) {
  remoteVideos.forEach(video => {
    video.srcObject = null;
  });
  remoteVideos = [];
  codecLabels = [];
  remoteVideosDiv.textContent = '';
  for (let i = 0; i < count; i++) {
    const container = document.createElement('div');
    container.className = 'video-container';

    const video = document.createElement('video');
    video.id = `remoteVideo${i + 1}`;
    video.autoplay = true;
    video.playsInline = true;

    const label = document.createElement('span');
    label.className = 'codec-label';
    label.textContent = '\u2026'; // ellipsis while waiting for stats

    container.appendChild(video);
    container.appendChild(label);
    remoteVideosDiv.appendChild(container);

    remoteVideos.push(video);
    codecLabels.push(label);
  }
}

function updateStatus() {
  statusDiv.textContent = connectionStates.map((state, i) => `#${i + 1}:${state}`).join(' ');
}
