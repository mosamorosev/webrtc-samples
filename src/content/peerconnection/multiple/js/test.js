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
    // webdriver.get() can occasionally return before navigation settles.
    // Retry until the expected URL is observed.
    return driver.get(url).then(() => driver.wait(() =>
      driver.executeScript(() => location.pathname).then(p => p.endsWith(path))
    ));
  });

  // This test does real WebRTC negotiation and can be slow on shared CI machines.
  it('establishes multiple connections and hangs up', async () => {
    const sentinel = () => driver.executeScript(() => {
      return typeof window.multiplePageLoaded !== 'undefined' &&
        window.multiplePageLoaded === true;
    }).catch(() => false);

    const sentinelDeadlineMs = Date.now() + 15000;
    // We explicitly catch WebDriver timeouts (rather than letting them bubble
    // into Jest) so we can print diagnostics to the CI log.
    while (Date.now() < sentinelDeadlineMs) {
      try {
        await driver.wait(sentinel, 2000);
        break;
      } catch (e) {
        if (!(e instanceof webdriver.error.TimeoutError)) {
          throw e;
        }
      }
    }

    const loaded = await sentinel();
    if (!loaded) {
      // Provide actionable diagnostics in CI logs when the page scripts
      // fail to execute in the webdriver environment.
      const diagnostics = await driver.executeScript(() => {
        const startButtonPresent = !!document.getElementById('startButton');
        return {
          href: location.href,
          pathname: location.pathname,
          title: document.title,
          readyState: document.readyState,
          startButtonPresent,
          multiplePageLoaded: window.multiplePageLoaded,
          multiplePageLoadTs: window.multiplePageLoadTs,
          errors: window.__multiplePageErrors || []
        };
      });
      // eslint-disable-next-line no-console
      console.error('multiple page diagnostics:', JSON.stringify(diagnostics));
      throw new Error('Timed out waiting for window.multiplePageLoaded');
    }
    await driver.wait(webdriver.until.elementLocated(webdriver.By.id('startButton')));

    await driver.findElement(webdriver.By.id('startButton')).click();

    await driver.wait(() => driver.executeScript(() => {
      return localStream !== null; // eslint-disable-line no-undef
    }));
    await driver.wait(() => driver.findElement(webdriver.By.id('callButton')).isEnabled());
    await driver.wait(() => driver.findElement(webdriver.By.id('videoCodecSelect')).isEnabled());
    await driver.findElement(webdriver.By.id('callButton')).click();
    await driver.wait(() => driver.findElement(webdriver.By.id('videoCodecSelect')).isEnabled()
        .then(enabled => !enabled));

    await driver.wait(() => driver.executeScript(() => {
      return window.callDone === true;
    }));

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
  }, 120000);
});
