/*
 *  Copyright (c) 2020 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */

'use strict';

const startButton = document.getElementById('startButton');
const callButton = document.getElementById('callButton');
const hangupButton = document.getElementById('hangupButton');
const captureSource = document.getElementById('captureSource');
callButton.disabled = true;
hangupButton.disabled = true;
startButton.addEventListener('click', start);
callButton.addEventListener('click', call);
hangupButton.addEventListener('click', hangup);

let startTime;
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

localVideo.addEventListener('loadedmetadata', function() {
  console.log(`Local video videoWidth: ${this.videoWidth}px,  videoHeight: ${this.videoHeight}px`);
});

remoteVideo.addEventListener('loadedmetadata', function() {
  console.log(`Remote video videoWidth: ${this.videoWidth}px,  videoHeight: ${this.videoHeight}px`);
});

remoteVideo.addEventListener('resize', () => {
  console.log(`Remote video size changed to ${remoteVideo.videoWidth}x${remoteVideo.videoHeight}`);
  // We'll use the first onsize callback as an indication that video has started
  // playing out.
  if (startTime) {
    const elapsedTime = window.performance.now() - startTime;
    console.log('Setup time: ' + elapsedTime.toFixed(3) + 'ms');
    startTime = null;
  }
});

const codecPreferences = document.getElementById('codecPreferences');
const supportsSetCodecPreferences = window.RTCRtpTransceiver &&
  'setCodecPreferences' in window.RTCRtpTransceiver.prototype;

let localStream;
let pc1;
let pc2;

const kScreenShareMaxWidth = 1920;
const kScreenShareMaxHeight = 1080;
const kScreenShareMaxFps = 30;

function getName(pc) {
  return (pc === pc1) ? 'pc1' : 'pc2';
}

function getOtherPc(pc) {
  return (pc === pc1) ? pc2 : pc1;
}

async function start() {
  console.log(`Requesting local stream from ${captureSource.value}`);
  startButton.disabled = true;
  // Release any previous local capture before creating a new one.
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    localVideo.srcObject = null;
  }
  codecPreferences.disabled = true;
  codecPreferences.options.length = 1;  // Keep "Default" option.
  try {
    const stream = captureSource.value === 'screen' ?
        await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: {max: kScreenShareMaxWidth},
            height: {max: kScreenShareMaxHeight},
            frameRate: {max: kScreenShareMaxFps},
          },
          audio: false,
        }) :
        await navigator.mediaDevices.getUserMedia({video: true});

    // Re-apply constraints on the display track to ensure a MFVEA-friendly
    // capture format even when chooser defaults to native monitor size.
    if (captureSource.value === 'screen') {
      const [screenTrack] = stream.getVideoTracks();
      if (screenTrack) {
        try {
          await screenTrack.applyConstraints({
            width: {max: kScreenShareMaxWidth},
            height: {max: kScreenShareMaxHeight},
            frameRate: {max: kScreenShareMaxFps},
          });
          const settings = screenTrack.getSettings();
          console.log(
              `Screen capture constrained to ${settings.width || 'unknown'}x${
                  settings.height ||
                  'unknown'} @ ${settings.frameRate || 'unknown'} fps`);
        } catch (applyError) {
          console.warn(
              `Failed to apply screen constraints: ${applyError.name}`);
        }
      }
    }

    console.log('Received local stream');
    localVideo.srcObject = stream;
    localStream = stream;
    callButton.disabled = false;
    captureSource.disabled = true;
  } catch (e) {
    startButton.disabled = false;
    const apiName =
        captureSource.value === 'screen' ? 'getDisplayMedia' : 'getUserMedia';
    alert(`${apiName}() error: ${e.name}`);
    return;
  }
  if (supportsSetCodecPreferences) {
    const {codecs} = RTCRtpReceiver.getCapabilities('video');
    let h264Option = null;
    codecs.forEach(codec => {
      if (['video/red', 'video/ulpfec', 'video/rtx', 'video/flexfec-03'].includes(codec.mimeType)) {
        return;
      }
      const option = document.createElement('option');
      option.value = (codec.mimeType + ' ' + (codec.sdpFmtpLine || '')).trim();
      option.innerText = option.value;
      codecPreferences.appendChild(option);
      if (!h264Option && codec.mimeType.toLowerCase() === 'video/h264') {
        h264Option = option;
      }
    });
    if (h264Option) {
      h264Option.selected = true;
      console.log('Defaulting preferred codec to H.264');
    }
    codecPreferences.disabled = false;
  }
}

async function call() {
  callButton.disabled = true;
  hangupButton.disabled = false;
  console.log('Starting call');
  startTime = window.performance.now();
  const videoTracks = localStream.getVideoTracks();
  if (videoTracks.length > 0) {
    console.log(`Using video device: ${videoTracks[0].label}`);
  }
  const configuration = {};
  console.log('RTCPeerConnection configuration:', configuration);
  pc1 = new RTCPeerConnection(configuration);
  console.log('Created local peer connection object pc1');
  pc1.addEventListener('icecandidate', e => onIceCandidate(pc1, e));
  pc2 = new RTCPeerConnection(configuration);
  console.log('Created remote peer connection object pc2');
  pc2.addEventListener('icecandidate', e => onIceCandidate(pc2, e));
  pc2.addEventListener('track', gotRemoteStream);

  localStream.getTracks().forEach(track => pc1.addTrack(track, localStream));
  console.log('Added local stream to pc1');
  codecPreferences.disabled = true;

  try {
    console.log('pc1 createOffer start');
    const offer = await pc1.createOffer();
    await onCreateOfferSuccess(offer);
  } catch (e) {
    onCreateSessionDescriptionError(e);
  }
}

function onCreateSessionDescriptionError(error) {
  console.log(`Failed to create session description: ${error.toString()}`);
}

async function onCreateOfferSuccess(desc) {
  console.log(`Offer from pc1\n${desc.sdp}`);
  console.log('pc1 setLocalDescription start');
  try {
    await pc1.setLocalDescription(desc);
    onSetLocalSuccess(pc1);
  } catch (e) {
    onSetSessionDescriptionError();
  }

  console.log('pc2 setRemoteDescription start');
  try {
    await pc2.setRemoteDescription(desc);
    onSetRemoteSuccess(pc2);
  } catch (e) {
    onSetSessionDescriptionError();
  }

  console.log('pc2 createAnswer start');
  try {
    const answer = await pc2.createAnswer();
    await onCreateAnswerSuccess(answer);
  } catch (e) {
    onCreateSessionDescriptionError(e);
  }
}

function onSetLocalSuccess(pc) {
  console.log(`${getName(pc)} setLocalDescription complete`);
}

function onSetRemoteSuccess(pc) {
  console.log(`${getName(pc)} setRemoteDescription complete`);
}

function onSetSessionDescriptionError(error) {
  console.log(`Failed to set session description: ${error.toString()}`);
}

function gotRemoteStream(e) {
  // Set codec preferences on the receiving side.
  if (e.track.kind === 'video' && supportsSetCodecPreferences) {
    const preferredCodec = codecPreferences.options[codecPreferences.selectedIndex];
    if (preferredCodec.value !== '') {
      const [mimeType, sdpFmtpLine] = preferredCodec.value.split(' ');
      const {codecs} = RTCRtpReceiver.getCapabilities('video');
      const selectedCodecIndex = codecs.findIndex(c => c.mimeType === mimeType && c.sdpFmtpLine === sdpFmtpLine);
      const selectedCodec = codecs[selectedCodecIndex];
      codecs.splice(selectedCodecIndex, 1);
      codecs.unshift(selectedCodec);
      e.transceiver.setCodecPreferences(codecs);
      console.log('Receiver\'s preferred video codec', selectedCodec);
    }
  }

  if (remoteVideo.srcObject !== e.streams[0]) {
    remoteVideo.srcObject = e.streams[0];
    console.log('pc2 received remote stream');
  }
}

async function onCreateAnswerSuccess(desc) {
  console.log(`Answer from pc2:\n${desc.sdp}`);
  console.log('pc2 setLocalDescription start');
  try {
    await pc2.setLocalDescription(desc);
    onSetLocalSuccess(pc2);
  } catch (e) {
    onSetSessionDescriptionError(e);
  }
  console.log('pc1 setRemoteDescription start');
  try {
    await pc1.setRemoteDescription(desc);
    onSetRemoteSuccess(pc1);

    // Display the video codec that is actually used.
    setTimeout(async () => {
      const stats = await pc1.getStats();
      stats.forEach(stat => {
        if (!(stat.type === 'outbound-rtp' && stat.kind === 'video')) {
          return;
        }
        const codec = stats.get(stat.codecId);
        document.getElementById('actualCodec').innerText = 'Using ' + codec.mimeType +
            (codec.sdpFmtpLine ? ' ' + codec.sdpFmtpLine + ' ' : '') +
            ', payloadType=' + codec.payloadType + '.';
        // Show encoder implementation name if available
        if (stat.encoderImplementation) {
          document.getElementById('actualCodec').innerText += ' Encoder: "' + stat.encoderImplementation + '".';
        }
        if (stat.powerEfficientEncoder !== undefined) {
          document.getElementById('actualCodec').innerText += ' Power efficient: ' + stat.powerEfficientEncoder + '.';
        }
      });
    }, 1000);
  } catch (e) {
    onSetSessionDescriptionError(e);
  }
}

async function onIceCandidate(pc, event) {
  try {
    await (getOtherPc(pc).addIceCandidate(event.candidate));
    onAddIceCandidateSuccess(pc);
  } catch (e) {
    onAddIceCandidateError(pc, e);
  }
  console.log(`${getName(pc)} ICE candidate:\n${event.candidate ? event.candidate.candidate : '(null)'}`);
}

function onAddIceCandidateSuccess(pc) {
  console.log(`${getName(pc)} addIceCandidate success`);
}

function onAddIceCandidateError(pc, error) {
  console.log(`${getName(pc)} failed to add ICE Candidate: ${error.toString()}`);
}

function hangup() {
  console.log('Ending call');
  pc1.close();
  pc2.close();
  pc1 = null;
  pc2 = null;
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  startButton.disabled = false;
  hangupButton.disabled = true;
  callButton.disabled = true;
  codecPreferences.disabled = true;
  captureSource.disabled = false;
}
