import {test} from 'node:test';
import assert from 'node:assert/strict';
import {associate, updateObjective} from './objectives.ts';
import type {Agent} from './tail.ts';
import type {Sky} from './read.ts';
const agent = ():Agent => ({id:'one',short:'one',cwd:'/project',subagent:false,intent:'Improve authoring and revision',lastAt:1,lastFile:null,lastTool:null,touched:[],tools:{},state:'active'});
const sky = {stars:[{name:'Workflow',areas:[{name:'authoring and revision',about:'Editing prose and reviewing changes',items:[],paths:['app.js']},{name:'visual language',about:'Typography and color',items:[],paths:['style.css']}]}]} as unknown as Sky;
test('objective placement is stable across actions in other areas',()=>{
 const a=agent(); a.lastFile='style.css'; a.lastTool='read_file';
 assert.equal(associate(a,sky).where?.area,'authoring and revision');
 a.lastFile='app.js'; assert.equal(associate(a,sky).where?.area,'authoring and revision');
});
test('assignment overrides inference, and ambiguity stays visible as unassigned',()=>{
 const a=agent(); a.assignedArea='visual language';assert.equal(associate(a,sky).where?.basis,'assigned');
 delete a.assignedArea;a.intent='authoring revision visual language';assert.equal(associate(a,sky).where,null);
 a.intent='Please do it';a.lastFile='app.js';assert.equal(associate(a,sky).where,null);
});
test('prompt steering updates objectives but acknowledgement and injected context do not',()=>{
 const a=agent();updateObjective(a,'yes, continue',2);assert.equal(a.intentAt,undefined);
 updateObjective(a,'<environment_context>irrelevant workspace instructions</environment_context>',3);assert.equal(a.intentAt,undefined);
 updateObjective(a,'<in-app-browser-context source="ambient">ignore this</in-app-browser-context>\n## My request:\nImprove visual language and typography so that all the generated graphics feel coherent.',4);
 assert.equal(associate(a,sky).where?.area,'visual language');assert.equal(a.intentAt,4);
});
