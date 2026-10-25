import test from 'node:test';
import assert from 'node:assert/strict';
import {openCorpus,chunkPages} from '../src/rag/corpus.js';
import {matchesInstrument} from '../src/rag/ingest.js';
const entry={id:'TEST',title:'Test Contract Act 2000',sourceUrl:'https://example.test/act.pdf',topics:['civil'],instrumentType:'act'};
const pages=[{page:3,lines:['Compensation for breach of contract shall follow the terms.']}];
test('RAG chunks retain page offsets and exact source text',()=>{
 const chunks=chunkPages(pages,4); assert.equal(chunks.length,3);
 for(const c of chunks) assert.equal(c.text,pages[0].lines[0].slice(c.start,c.end));
});
test('corpus search returns provenance, filters topics, and removes superseded chunks atomically',()=>{
 const c=openCorpus(':memory:');try{
 c.replace(entry,{url:entry.sourceUrl,sha256:'abc'},pages);
 assert.equal(c.search('compensation',{topic:'civil'}).length,1);
 assert.equal(c.search('compensation',{topic:'cyber'}).length,0);
 assert.equal(c.search('compensation')[0].sha256,'abc');
 assert.match(c.search('compensation')[0].legalCurrency,/Unreviewed/);
 c.replace(entry,{url:entry.sourceUrl,sha256:'new'},[{page:1,lines:['New remedy text']}]);
 assert.equal(c.search('compensation').length,0);assert.equal(c.search('remedy').length,1);
 c.replace(entry,null,null,'unavailable');assert.equal(c.search('remedy').length,0);
 assert.equal(c.coverage()[0].chunks,0);
 }finally{c.close();}
});
test('query syntax is treated as data and foreign or unrelated topic does not leak',()=>{
 const c=openCorpus(':memory:');try{
 c.replace(entry,{url:entry.sourceUrl,sha256:'abc'},pages);
 assert.doesNotThrow(()=>c.search('" OR * NEAR('));
 assert.equal(c.search('contract',{instrument:'OTHER'}).length,0);
 }finally{c.close();}
});
test('landing pages and unrelated PDFs cannot establish instrument identity',()=>{
 assert.equal(matchesInstrument(entry,[{page:1,lines:['Error page not found']}]),false);
 assert.equal(matchesInstrument(entry,[{page:1,lines:['Test Contract Act 2000']}]),true);
});
test('partial title token overlap is insufficient to index guidance as a statute',()=>{
 assert.equal(matchesInstrument({title:'CERT-In Cyber Security Directions under section 70B(6), 2022'},[{page:1,lines:['CERT In cyber security advice. Section 70B directions exist. MSME guidance 2022.']}]),false);
});
