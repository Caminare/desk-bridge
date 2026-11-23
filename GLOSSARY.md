# DeskBridge

Remote control of personal Windows PCs from a phone or browser through a self-hosted relay.

## Language

**Host**:
A PC enrolled in the fleet that can be controlled remotely.
_Avoid_: Agent (the agent is the program running on the host), machine

**Controller**:
The phone or browser app used to view and control a host.
_Avoid_: Client, viewer

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
