(async()=>{
 const {__newTabTreeExpect:x}=await chrome.storage.local.get('__newTabTreeExpect');
 const {rt}=await chrome.storage.session.get('rt');
 return [
  [!rt.tabParent[x.root]&&rt.treeDetached[x.root],'looked-up New Tab stays a root after extension reload'],
  [rt.tabParent[x.explicit]===x.parent,'explicit child keeps its parent after reload'],
  [rt.tabParent[x.manual]===x.parent,'manually nested blank tab keeps its parent after reload'],
 ].map(([pass,label])=>`${pass?'PASS':'FAIL'} ${label}`).join('\n');
})()
