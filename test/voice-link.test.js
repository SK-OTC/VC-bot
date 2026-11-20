import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelLink } from '../src/voice-link.js';

const G = '111111111111111111';
const C = '222222222222222222';

test('a Discord channel link is recognised, with or without < > or a trailing slash', () => {
  for (const loc of [`https://discord.com/channels/${G}/${C}`, `<https://discord.com/channels/${G}/${C}>`, `https://discord.com/channels/${G}/${C}/`, `  https://discord.com/channels/${G}/${C}  `]) {
    assert.deepEqual(parseChannelLink(loc), { guildId: G, channelId: C }, loc);
  }
});

test('everything else is "not a voice channel link": the bot never tries to join', () => {
  for (const loc of [
    null,
    undefined,
    '',
    'Room 4B',
    'Voice channel',
    `<#${C}>`, // a mention is not a link
    C,
    `https://discord.com/channels/${G}/${C}/333333333333333333`, // a message link
    `https://discord.com/channels/@me/${C}`, // a direct-message link
    `https://discord.com/channels/${G}`,
    `https://meet.google.com/abc-defg-hij`,
    `https://zoom.us/j/123456789`,
    `http://discord.com/channels/${G}/${C}`, // not https
    `https://evil.example/https://discord.com/channels/${G}/${C}`,
    `https://discord.com.evil.example/channels/${G}/${C}`,
    `Join us: https://discord.com/channels/${G}/${C}`, // only the link itself, nothing around it
    `https://discord.com/channels/${G}/${C}?x=1`,
    `https://discord.com/channels/12345/${C}`, // not a real id length
  ]) {
    assert.equal(parseChannelLink(loc), null, String(loc));
  }
});
