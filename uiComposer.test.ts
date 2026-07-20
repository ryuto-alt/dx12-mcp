import assert from "node:assert/strict";
import { composeUi } from "./uiComposer.ts";

let next = 1;
const calls: any[] = [];
const engine = {
  async call(method: string, params: any) {
    calls.push({method, params});
    if (method === "create_entity") {
      const id = next++;
      return params.type === "ui_button" ? {entityId:id, entityIds:[id,next++]} : {entityId:id, entityIds:[id]};
    }
    return {ok:true};
  }
};

const result = await composeUi(engine, { theme:"horror", prefix:"Pause", root:{
  name:"Root", kind:"panel", role:"root", layout:{dock:"fill"}, children:[
    {name:"Menu", kind:"stack", layout:{dock:"center",width:480,height:280}, flow:{cellHeight:56,spacing:16}, children:[
      {name:"Resume",kind:"button",role:"cta",text:"RESUME",event:"resume"},
      {name:"Quit",kind:"button",text:"QUIT",event:"quit"},
    ]}
  ]
}});
assert.equal(result.theme, "horror");
assert.ok(result.entityIds.length >= 7); // canvas, root, stack, 2 buttons + 2 labels
assert.ok(calls.some(c => c.method === "set_component" && c.params.component === "uiLayout"));
assert.ok(calls.some(c => c.method === "set_component" && c.params.component === "uiText" && c.params.data.text === "RESUME"));
assert.ok(calls.some(c => c.method === "set_component" && c.params.component === "uiImage" && c.params.data.color?.[0] === .55));

await assert.rejects(() => composeUi(engine, { root:{name:"A",children:[{name:"A"}]} }), /重複/);
console.log("OK: UIコンポーザーテスト通過");
