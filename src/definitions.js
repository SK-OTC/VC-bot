// Slash command definitions, shared by the registration script and the tests.
// Discord requires every required option to come before the optional ones.

const T = { SUB_COMMAND: 1, STRING: 3, INTEGER: 4, BOOLEAN: 5, CHANNEL: 7, ROLE: 8 };
const CHANNEL_TYPES = [0, 2, 5]; // text, voice (its text chat), announcement
const VOICE_ONLY = [2];
const TEXT_ONLY = [0, 5]; // text, announcement
const MANAGE_SERVER = '32'; // Discord permission bit 1<<5, sent as a string

const opt = (type, name, description, extra = {}) => ({ type, name, description, ...extra });

const scheduleOptions = {
  channel: opt(T.CHANNEL, 'channel', 'Where reminders are posted (default: this channel)', {
    channel_types: CHANNEL_TYPES,
  }),
  location: opt(T.STRING, 'location', 'Voice channel, link, or place (on update: "none" clears it)', {
    max_length: 200,
  }),
  reminder: opt(T.STRING, 'reminder', 'How long before to remind: 2h, 1h30min, 15min (plain number = hours, 0 = none)', {
    max_length: 20,
  }),
  timezone: opt(T.STRING, 'timezone', 'Timezone for the date/time you typed (default: your /set-timezone)', {
    autocomplete: true,
  }),
  duration: opt(T.STRING, 'duration', 'How long the meeting is: 1h, 90min, 1h30min (15 min to 2 h, default 1 h)', {
    max_length: 20,
  }),
  team: opt(T.STRING, 'team', 'Guest team to invite to the Google Calendar event, or "none"', { autocomplete: true }),
  calendar: opt(T.BOOLEAN, 'calendar', 'Add this meeting to your Google Calendar (default: yes, if connected)'),
  meet: opt(T.BOOLEAN, 'meet', 'Create a Google Meet link for the calendar event (default: yes)'),
  repeat: opt(T.STRING, 'repeat', 'Repeat weekly at the same local time?', {
    choices: [
      { name: 'No (one-off)', value: 'none' },
      { name: 'Weekly', value: 'weekly' },
    ],
  }),
  ping: opt(T.ROLE, 'ping', 'Role to mention when the meeting is scheduled, at the reminder and at the start'),
  // Only offered (autocomplete) when the location is a Discord voice channel link; the handlers refuse it for any other location.
  recording_setup: opt(T.STRING, 'recording_setup', 'Recording setup, for a Discord voice channel location only (default: Default)', {
    max_length: 50,
    autocomplete: true,
  }),
};

// Discord's role picker takes one role per option, so extra roles get their own options.
// Passing any of these replaces the whole set of roles to ping.
export const PING_OPTION_NAMES = ['ping', 'ping_2', 'ping_3', 'ping_4', 'ping_5'];
const pingOptions = PING_OPTION_NAMES.map((name, i) =>
  i === 0 ? scheduleOptions.ping : opt(T.ROLE, name, 'Another role to mention (same times as the first role)'),
);

// Every command is top-level, so each shows up on its own in Discord's slash menu.
// Only /recording (setup, voice-channel, list, delete) has subcommands.
const emailsText = 'One or many email addresses, separated by commas, semicolons or spaces';
const guestEmails = opt(T.STRING, 'emails', emailsText, { required: true, max_length: 6000 });
const teamRequired = opt(T.STRING, 'team', 'Team name', { required: true, max_length: 50, autocomplete: true });

export const COMMANDS = [
  {
    name: 'new-meeting',
    description: 'Schedule a meeting, or schedule a saved preset / past meeting again',
    contexts: [0], // servers only
    options: [
      opt(T.STRING, 'name', 'Meeting name (pick a saved preset or past meeting to reuse its settings)', {
        required: true,
        max_length: 80,
        autocomplete: true,
      }),
      opt(T.STRING, 'date', 'YYYY-MM-DD, "today", or "tomorrow"', { required: true }),
      opt(T.STRING, 'time', 'Start time, e.g. 15:00 or 3pm (default: the saved time of a reused preset)'),
      scheduleOptions.channel,
      scheduleOptions.location,
      scheduleOptions.reminder,
      scheduleOptions.timezone,
      scheduleOptions.repeat,
      ...pingOptions,
      scheduleOptions.duration,
      scheduleOptions.team,
      scheduleOptions.calendar,
      scheduleOptions.meet,
      scheduleOptions.recording_setup,
      opt(T.BOOLEAN, 'reuse', 'Reuse the settings of a saved preset or past meeting with this name (default: yes)'),
    ],
  },
  {
    name: 'update-meeting',
    description: 'Change an existing meeting',
    contexts: [0],
    options: [
      opt(T.STRING, 'name', 'Which meeting', { required: true, autocomplete: true }),
      opt(T.STRING, 'new_name', 'Rename it', { max_length: 80 }),
      opt(T.STRING, 'date', 'New date: YYYY-MM-DD, "today", or "tomorrow"'),
      opt(T.STRING, 'time', 'New time, e.g. 15:00 or 3pm'),
      scheduleOptions.channel,
      scheduleOptions.location,
      scheduleOptions.reminder,
      scheduleOptions.timezone,
      scheduleOptions.repeat,
      ...pingOptions,
      scheduleOptions.duration,
      scheduleOptions.team,
      scheduleOptions.calendar,
      scheduleOptions.meet,
      scheduleOptions.recording_setup,
    ],
  },
  {
    name: 'cancel-meeting',
    description: 'Cancel a meeting and its reminders',
    contexts: [0],
    options: [opt(T.STRING, 'name', 'Which meeting', { required: true, autocomplete: true })],
  },
  {
    name: 'upcoming-meetings',
    description: 'Show upcoming meetings in this server',
    contexts: [0],
  },
  {
    name: 'add-update-preset',
    description: 'Save meeting settings to reuse later (or edit a saved preset)',
    contexts: [0],
    options: [
      opt(T.STRING, 'name', 'Preset name', { required: true, max_length: 80, autocomplete: true }),
      opt(T.STRING, 'time', 'Usual start time, e.g. 15:00 or 3pm ("none" clears it)'),
      scheduleOptions.channel,
      scheduleOptions.location,
      scheduleOptions.reminder,
      scheduleOptions.timezone,
      scheduleOptions.repeat,
      ...pingOptions,
      scheduleOptions.duration,
      scheduleOptions.team,
      scheduleOptions.calendar,
      scheduleOptions.meet,
      scheduleOptions.recording_setup,
    ],
  },
  {
    name: 'meeting-presets',
    description: 'Show the saved meeting presets in this server',
    contexts: [0],
  },
  {
    name: 'delete-preset',
    description: 'Delete a saved preset',
    contexts: [0],
    options: [opt(T.STRING, 'name', 'Which preset', { required: true, autocomplete: true })],
  },
  {
    name: 'add-team',
    description: 'Add email addresses to a guest team (creates the team the first time)',
    contexts: [0],
    options: [teamRequired, guestEmails],
  },
  {
    // Give either emails (remove those people) or all:True (delete the whole team); the handler refuses neither and both.
    name: 'remove-team-member',
    description: 'Remove email addresses from a guest team, or delete the whole team (all:True)',
    contexts: [0],
    options: [
      teamRequired,
      opt(T.STRING, 'emails', `${emailsText} (or use all:True)`, { max_length: 6000 }),
      opt(T.BOOLEAN, 'all', 'Delete the whole team and every address on it'),
    ],
  },
  {
    name: 'show-teams',
    description: 'Show your guest teams, or the addresses on one team',
    contexts: [0],
    options: [opt(T.STRING, 'team', 'Team name (leave out to list your teams)', { max_length: 50, autocomplete: true })],
  },
  {
    // No subcommands: it shows whether you are connected, with a Connect or Disconnect button (see cmdCalendar).
    name: 'calendar',
    description: 'See whether your Google Calendar is connected, and connect or disconnect it',
    contexts: [0],
    options: [opt(T.STRING, 'url', 'Only if you use the older Apps Script bridge: your web app URL (ends in /exec)', { max_length: 300 })],
  },
  {
    // Admin only: only people with Manage Server see it by default (server admins can change that in Discord's settings). The
    // handlers check the permission again, so hiding the command is a convenience, not the protection. Discord applies this to the
    // whole command, which is why /start-recording and /stop-recording (for everyone) are not subcommands of it.
    name: 'recording',
    description: 'Recording setups and which voice channels may be recorded (admins only)',
    contexts: [0],
    default_member_permissions: MANAGE_SERVER,
    options: [
      opt(T.SUB_COMMAND, 'setup', 'Create or change a recording setup: where transcripts and summaries go (just the name = show it)', {
        options: [
          opt(T.STRING, 'name', 'Setup name. "Default" is used by /start-recording and by meetings that pick none', { required: true, max_length: 50, autocomplete: true }),
          opt(T.CHANNEL, 'private_channel', 'Private text channel for the transcript file (and the audio, if on)', { channel_types: TEXT_ONLY }),
          opt(T.CHANNEL, 'summary_channel', 'Text channel for the summary and its link (default: with the transcript)', { channel_types: TEXT_ONLY }),
          opt(T.CHANNEL, 'link_channel', 'Text channel for a "recording ready" link to the transcript (default: none)', { channel_types: TEXT_ONLY }),
          opt(T.BOOLEAN, 'audio', 'Also post the audio files in the private channel (default: off)'),
          opt(T.STRING, 'clear', 'Make a channel blank again (blank = taken from the Default setup)', {
            choices: [
              { name: 'private_channel', value: 'private_channel' },
              { name: 'summary_channel', value: 'summary_channel' },
              { name: 'link_channel', value: 'link_channel' },
              { name: 'all channels', value: 'all' },
            ],
          }),
          opt(T.BOOLEAN, 'save', 'Default only, whole server: keep transcripts and summaries, with a private web page (default: on)'),
          opt(T.BOOLEAN, 'post', 'Default only, whole server: post transcripts and summaries in channels (default: on)'),
        ],
      }),
      opt(T.SUB_COMMAND, 'voice-channel', 'Allow a voice channel to be recorded, or change it (just the channel = show it)', {
        options: [
          opt(T.CHANNEL, 'voice_channel', 'The voice channel', { required: true, channel_types: VOICE_ONLY }),
          opt(T.STRING, 'name', 'Team or meeting name shown in the transcript heading (default: the voice channel name)', { max_length: 50 }),
          opt(T.CHANNEL, 'backup_channel', 'Optional private text channel for the audio backup', { channel_types: TEXT_ONLY }),
          opt(T.STRING, 'language', 'Spoken language, a 2-letter code such as en, es, fr (default: en)', { max_length: 3 }),
          opt(T.STRING, 'glossary', 'Correct spellings, comma-separated. Add mishearings with =, e.g. LiteCut=Lite Cut|Lite cut', { max_length: 500 }),
          opt(T.STRING, 'clear', 'Remove a setting', {
            choices: [
              { name: 'backup_channel', value: 'backup_channel' },
              { name: 'glossary', value: 'glossary' },
            ],
          }),
        ],
      }),
      opt(T.SUB_COMMAND, 'list', 'Show every recording setup and every voice channel that may be recorded'),
      opt(T.SUB_COMMAND, 'delete', 'Delete a recording setup (name), or stop a voice channel being recordable (voice_channel)', {
        options: [
          opt(T.STRING, 'name', 'Recording setup to delete (meetings that use it fall back to Default)', { max_length: 50, autocomplete: true }),
          opt(T.CHANNEL, 'voice_channel', 'Voice channel that may no longer be recorded', { channel_types: VOICE_ONLY }),
        ],
      }),
    ],
  },
  {
    name: 'start-recording',
    description: 'Record, transcribe and summarise a voice channel meeting',
    contexts: [0],
    options: [
      opt(T.CHANNEL, 'channel', 'Voice channel to record (default: the one you are in now)', { channel_types: VOICE_ONLY }),
    ],
  },
  {
    name: 'stop-recording',
    description: 'End the recording now: the bot leaves, then posts the transcript and summary',
    contexts: [0],
    options: [
      opt(T.CHANNEL, 'channel', 'Which voice channel (only needed if more than one is being recorded)', { channel_types: VOICE_ONLY }),
      opt(T.BOOLEAN, 'force', 'Clear a stuck recording that will not stop (the bot may need to be removed by hand)'),
    ],
  },
  {
    name: 'set-timezone',
    description: 'Set your timezone for meeting times you type',
    contexts: [0],
    options: [opt(T.STRING, 'timezone', 'e.g. America/Chicago, Europe/London, Asia/Karachi', { required: true, autocomplete: true })],
  },
];
