(async()=>{
  const {__externalLinkTree:x}=await chrome.storage.local.get('__externalLinkTree');
  const {rt}=await chrome.storage.session.get('rt');
  return [
    [!rt.tabParent[x.external]&&!rt.tabParent[x.essentialExternal],'reload never infers parents for external tabs from Chrome opener hints'],
    [rt.tabParent[x.linked]===x.parent,'reload preserves the saved parent of a confirmed page link'],
  ].map(([pass,label])=>`${pass?'PASS':'FAIL'} ${label}`).join('\n');
})()
