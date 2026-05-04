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
// One shared sender PC encodes the local stream; each view has its own receiver PC.
let senderPc;
let receiverPcs = [];
// Backward-compatible global expected by selenium tests.
// Keep a single entry that reflects the current topology.
// Exported for webdriver tests via window.peerPairs.
let peerPairs = [];
let remoteVideos = [];
let connectionStates = [];
let statsUpdateInterval;

const supportsSetCodecPreferences = window.RTCRtpTransceiver &&
  'setCodecPreferences' in window.RTCRtpTransceiver.prototype;
initCodecSelect();
// Exposed for webdriver test synchronization.
window.multiplePageLoaded = true;
window.multiplePageLoadTs = Date.now();
window.__multiplePageErrors = [];
window.addEventListener('error', event => {
  window.__multiplePageErrors.push({
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno
  });
});
window.addEventListener('unhandledrejection', event => {
  const reason = event.reason;
  window.__multiplePageErrors.push({
    message: reason && reason.message ? reason.message : String(reason)
  });
});
videoCodecSelect.onchange = () => {
  preferredVideoCodecMimeType = videoCodecSelect.value;
};

window.peerPairs = peerPairs;
window.callDone = false;

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

  // Update local video info when metadata loads
  video1.addEventListener('loadedmetadata', () => {
    updateLocalVideoInfo();
  });
  video1.addEventListener('resize', () => {
    updateLocalVideoInfo();
  });

  callButton.disabled = false;
}

async function call() {
  window.callDone = false;
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

  senderPc = new RTCPeerConnection();
  receiverPcs = new Array(receiveVideoCount).fill(null).map(() => new RTCPeerConnection());
  peerPairs = [{senderPc, receiverPc: receiverPcs[0]}];
  window.peerPairs = peerPairs;

  const videoTrack = videoTracks[0];
  const audioTrack = audioTracks[0];

  // Build N independent calls:
  // - One shared senderPc holds N transceivers (one video + optional audio per view).
  // - Each receiverPc negotiates with senderPc only for its own transceivers.
  for (let i = 0; i < receiveVideoCount; i++) {
    const receiverPc = receiverPcs[i];

    senderPc.onicecandidate = e => {
      if (!e.candidate) return;
      receiverPcs.forEach((pc, idx) => {
        pc.addIceCandidate(e.candidate).catch(err => {
          console.warn(`receiverPc[${idx}].addIceCandidate failed`, err);
        });
      });
    };
    receiverPc.onicecandidate = e => {
      if (e.candidate) {
        senderPc.addIceCandidate(e.candidate).catch(err => {
          console.warn('senderPc.addIceCandidate failed', err);
        });
      }
    };
    receiverPc.onconnectionstatechange = () => {
      connectionStates[i] = receiverPc.connectionState;
      updateStatus();
    };

    const stream = new MediaStream([videoTrack, audioTrack].filter(Boolean));
    const videoTransceiver = senderPc.addTransceiver(videoTrack, {
      direction: 'sendonly',
      streams: [stream]
    });
    applyCodecPreferences(videoTransceiver, i + 1);
    if (audioTrack) {
      senderPc.addTransceiver(audioTrack, {
        direction: 'sendonly',
        streams: [stream]
      });
    }

    receiverPc.ontrack = e => {
      if (e.track.kind !== 'video') return;
      const incomingStream = e.streams[0] || new MediaStream([e.track]);
      if (remoteVideos[i] && remoteVideos[i].srcObject !== incomingStream) {
        remoteVideos[i].srcObject = incomingStream;
        console.log(`video${i + 1}: received remote stream`);
      }
    };

    const offer = await senderPc.createOffer();
    await senderPc.setLocalDescription(offer);
    await receiverPc.setRemoteDescription(offer);
    const answer = await receiverPc.createAnswer();
    await receiverPc.setLocalDescription(answer);
    await senderPc.setRemoteDescription(answer);
  }
  console.log('negotiation completed');
  window.callDone = true;
  updateStatus();

  // Start updating stats periodically
  if (statsUpdateInterval) {
    clearInterval(statsUpdateInterval);
  }
  statsUpdateInterval = setInterval(() => {
    updateLocalVideoInfo();
    for (let i = 0; i < remoteVideos.length; i++) {
      updateVideoInfo(i);
    }
  }, 1000);
}

function hangup() {
  console.log('Ending call');
  window.callDone = false;
  if (statsUpdateInterval) {
    clearInterval(statsUpdateInterval);
    statsUpdateInterval = null;
  }
  if (senderPc) {
    senderPc.close();
    senderPc = null;
  }
  receiverPcs.forEach(pc => pc.close());
  receiverPcs = [];
  peerPairs = [];
  window.peerPairs = peerPairs;
  resetRemoteVideos(0);
  connectionStates = [];
  statusDiv.textContent = '';
  const localInfoDiv = document.getElementById('localVideoInfo');
  if (localInfoDiv) {
    localInfoDiv.textContent = 'Local video';
  }
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
  remoteVideosDiv.textContent = '';
  for (let i = 0; i < count; i++) {
    const container = document.createElement('div');
    container.className = 'video-container';

    const video = document.createElement('video');
    video.id = `remoteVideo${i + 1}`;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;

    const info = document.createElement('div');
    info.className = 'video-info';
    info.id = `videoInfo${i + 1}`;
    info.textContent = 'Loading...';

    container.appendChild(video);
    container.appendChild(info);
    remoteVideosDiv.appendChild(container);

    remoteVideos.push(video);

    // Update resolution when video metadata loads
    video.addEventListener('loadedmetadata', () => {
      updateVideoInfo(i);
    });

    // Also update on resize in case resolution changes
    video.addEventListener('resize', () => {
      updateVideoInfo(i);
    });
  }
}

function updateStatus() {
  statusDiv.textContent = connectionStates.map((state, i) => `#${i + 1}:${state}`).join(' ');
}

async function updateVideoInfo(index) {
  const video = remoteVideos[index];
  const infoDiv = document.getElementById(`videoInfo${index + 1}`);
  if (!video || !infoDiv) return;

  const resolution = `${video.videoWidth}x${video.videoHeight}`;
  let codec = 'Unknown';
  let decoderImpl = '';

  // Try to get codec and decoder implementation from stats
  const receiverPc = receiverPcs[index];
  if (receiverPc) {
    try {
      const stats = await receiverPc.getStats();
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const codecId = report.codecId;
          // Get decoder implementation
          if (report.decoderImplementation) {
            decoderImpl = report.decoderImplementation;
          }
          if (codecId) {
            stats.forEach(codecReport => {
              if (codecReport.id === codecId && codecReport.type === 'codec') {
                codec = codecReport.mimeType || 'Unknown';
                // Extract just the codec name (e.g., "video/VP8" -> "VP8")
                if (codec.includes('/')) {
                  codec = codec.split('/')[1];
                }
              }
            });
          }
        }
      });
    } catch (err) {
      console.warn(`Failed to get stats for video ${index + 1}:`, err);
    }
  }

  // Format: Resolution | Codec | Decoder Implementation
  const parts = [resolution, codec];
  if (decoderImpl) {
    parts.push(decoderImpl);
  }
  infoDiv.textContent = parts.join(' | ');
}

async function updateLocalVideoInfo() {
  const video = video1;
  const infoDiv = document.getElementById('localVideoInfo');
  if (!video || !infoDiv) return;

  const resolution = `${video.videoWidth}x${video.videoHeight}`;

  if (!senderPc) {
    infoDiv.textContent = `${resolution} | Not connected`;
    return;
  }

  let codec = 'Unknown';
  let encoderImpl = '';

  // Get codec and encoder implementation from stats
  try {
    const stats = await senderPc.getStats();
    stats.forEach(report => {
      if (report.type === 'outbound-rtp' && report.kind === 'video') {
        const codecId = report.codecId;
        // Get encoder implementation
        if (report.encoderImplementation) {
          encoderImpl = report.encoderImplementation;
        }
        if (codecId) {
          stats.forEach(codecReport => {
            if (codecReport.id === codecId && codecReport.type === 'codec') {
              codec = codecReport.mimeType || 'Unknown';
              // Extract just the codec name (e.g., "video/VP8" -> "VP8")
              if (codec.includes('/')) {
                codec = codec.split('/')[1];
              }
            }
          });
        }
      }
    });
  } catch (err) {
    console.warn('Failed to get stats for local video:', err);
  }

  // Format: Resolution | Codec | Encoder Implementation
  const parts = [resolution, codec];
  if (encoderImpl) {
    parts.push(encoderImpl);
  }
  infoDiv.textContent = parts.join(' | ');
}
