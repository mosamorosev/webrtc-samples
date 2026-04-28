/*
 *  Copyright (c) 2015 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
/* eslint-env node */

'use strict';
const webdriver = require('selenium-webdriver');
const seleniumHelpers = require('../../../../../test/webdriver');

let driver;
const path = '/src/content/peerconnection/multiple/index.html';
const url = `${process.env.BASEURL ? process.env.BASEURL : ('file://' + process.cwd())}${path}`;

describe('multiple peerconnections', () => {
  beforeAll(async () => {
    driver = await seleniumHelpers.buildDriver();
  });
  afterAll(() => {
    return driver.quit();
  });

  beforeEach(() => {
    return driver.get(url);
  });

  // This test does real WebRTC negotiation and can be slow
  // on shared CI machines when multiple peer connections are created.
  it('establishes multiple connections and hangs up', async () => {
    await driver.wait(() => driver.executeScript(() => {
      return document.getElementById('videoCountInput').value === '2';
    }));
    await driver.wait(() => driver.executeScript(() => {
      return document.getElementById('videoCodecSelect').options.length > 0;
    }));

    await driver.findElement(webdriver.By.id('startButton')).click();

    await driver.wait(() => driver.executeScript(() => {
      return localStream !== null; // eslint-disable-line no-undef
    }));
    await driver.wait(() => driver.findElement(webdriver.By.id('callButton')).isEnabled());
    await driver.wait(() => driver.findElement(webdriver.By.id('videoCodecSelect')).isEnabled());
    await driver.findElement(webdriver.By.id('callButton')).click();
    await driver.wait(() => driver.findElement(webdriver.By.id('videoCodecSelect')).isEnabled()
        .then(enabled => !enabled));

    // With the new topology there is one senderPc + one receiverPc regardless
    // of the number of requested receive videos.
    await driver.wait(() => driver.executeScript(() => {
      return peerPairs.length === 1; // eslint-disable-line no-undef
    }));
    await driver.wait(() => driver.executeScript(() => {
      return peerPairs[0].receiverPc.connectionState === 'connected'; // eslint-disable-line no-undef
    }));

    await Promise.all([
      driver.wait(() => driver.executeScript(() => {
        return document.getElementById('remoteVideo1').readyState === HTMLMediaElement.HAVE_ENOUGH_DATA;
      })),
      driver.wait(() => driver.executeScript(() => {
        return document.getElementById('remoteVideo2').readyState === HTMLMediaElement.HAVE_ENOUGH_DATA;
      })),
    ]);

    await driver.findElement(webdriver.By.id('hangupButton')).click();

    await driver.wait(() => driver.executeScript(() => {
      return peerPairs.length === 0; // eslint-disable-line no-undef
    }));
    await driver.wait(() => driver.findElement(webdriver.By.id('videoCodecSelect')).isEnabled());
  }, 20000);
});
