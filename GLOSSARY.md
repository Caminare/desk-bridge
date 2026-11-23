# DeskBridge

Remote control of personal Windows PCs from a phone or browser through a self-hosted relay.

## Language

**Host**:
A PC enrolled in the fleet that can be controlled remotely.
_Avoid_: Agent (the agent is the program running on the host), machine

**Controller**:
The phone or browser app used to view and control a host.
_Avoid_: Client, viewer

### Keyboard

**Key event**:
One physical key going down or up, identified by its position on the keyboard rather than the character it produces. The host's keyboard layout decides the character.
_Avoid_: Keystroke, hotkey

**Text input**:
Finished text (characters, accents, emoji) delivered to the host as-is, independent of any keyboard layout. Used by the soft keyboard and Dictation.
_Avoid_: Typing, keystrokes

**Chord**:
Modifiers plus one key or character, pressed and released together in a single step, such as Ctrl+Shift+T. Characters are resolved with the host's keyboard layout.
_Avoid_: Hotkey, combo, shortcut (in protocol terms)

### Audio

**Listen**:
Hearing the host's default output device on the controller.
_Avoid_: Audio streaming, PC sound

**Talk**:
The controller's microphone acting as a microphone on the host, so host apps such as meeting software hear the user. Turning on Talk also turns on Listen.
_Avoid_: Voice, mic streaming

**Dictation**:
Speech on the controller turned into typed text on the host, from the keyboard drawer. Unavailable while Talk is on.
_Avoid_: Voice input, transcription
