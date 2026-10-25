import test from 'node:test';
import assert from 'node:assert/strict';
import {selectPreferredVoice,voiceProfile,normaliseSpeechRate} from '../web/voiceSelector.js';
const female={name:'Samantha',lang:'en-US',voiceURI:'samantha'};
const male={name:'Daniel',lang:'en-GB',voiceURI:'daniel'};
test('explicit profiles select the requested available voice and do not silently cross profiles',()=>{
 assert.equal(selectPreferredVoice([female,male],'female'),female);
 assert.equal(selectPreferredVoice([female,male],'male'),male);
 assert.equal(selectPreferredVoice([female],'male'),null);
 assert.equal(selectPreferredVoice([female,male],'voice:daniel'),male);
 assert.equal(voiceProfile({name:'Unknown voice'}),null);
});
test('voice language and rate preferences have predictable bounds',()=>{
 assert.equal(selectPreferredVoice([{...male,lang:'fr-FR'}],'male'),null);
 assert.equal(normaliseSpeechRate(10),1.3);assert.equal(normaliseSpeechRate(.1),.7);assert.equal(normaliseSpeechRate('bad'),.95);
});
