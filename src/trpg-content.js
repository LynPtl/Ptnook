const route = (id, label, next, extra = {}) => ({ id, label, next, ...extra });
const challenge = (id, label, stat, extra = {}) => ({ id, label, check: { stat, difficulty: 12 }, success: "达成意图，取得完整线索。", partial: "取得主要线索，但承担一项后续人情。", failure: "线索仍然可得，但对方更加戒备。", ...extra });

export const CAMPAIGN = {
  id: "mist-bell-v1", name: "雾钟镇来信", version: 1,
  introduction: "你们共同护送一封迟到的信来到边境小镇。每到午夜，无人看守的钟楼都会响起；收信人的名字却从镇志里消失了。你们可以查明真相、保护镇民，或为旧约找到另一条出路。",
  truth: "二十年前的洪水中，镇民与钟楼中的回声签约，以记忆维持挡水结界。镇长奥林隐瞒了逐年加重的代价；守钟人梅拉试图修改契约，名字被抹去，但本人活着藏在旧船坞。回声不是恶魔，只按约取走被主动承诺的记忆。三条解决路径为维持并限制旧约、拆除契约并组织迁移、以所有人自愿留下的见证取代遗忘。绝不能把梅拉改成已死或幕后恶人。",
  npcs: [
    { id: "ilai", name: "伊莱", public: "镇档案管理员，谨慎而爱惜旧书。", secret: "知道删去的档案流向钟楼，但不知道契约全文。" },
    { id: "mela", name: "梅拉", public: "来信的收信人，曾经的守钟人。", secret: "活着藏在旧船坞，持有替代契约草稿，害怕牵连证人。" },
    { id: "olin", name: "奥林", public: "镇长，相信维护秩序能保护镇民。", secret: "知道遗忘的代价上升，害怕解除契约会再度洪水。" },
    { id: "echo", name: "钟楼回声", public: "尚未见面的钟楼存在。", secret: "只能执行自愿承诺的契约，不主动制造洪水，愿意接受等效的见证替代。" },
  ],
  chapters: [
    { id: 1, name: "无人收取的信", scenes: [
      { id: "gate", name: "雾中的镇口", goal: "确认收信人的线索", safe: true, text: "薄雾贴着石桥流动。告示牌上的旧名单有一块被反复擦去的痕迹，旅店老板指出镇档案室仍保留旧居民名册。你们手中的信写着：请在最后一次钟声前找到梅拉。", options: [
        route("archive", "去档案室核对名字", "archive"),
        challenge("notice", "仔细检查告示上的擦痕", "insight", { clue: ["erased", "被擦去的名字", "擦痕并非风化，名单中有人被人为删除。"], once: true }),
      ] },
      { id: "archive", name: "档案室的印章", goal: "找到梅拉的去向", safe: true, npc: "ilai", text: "伊莱将手压在一本旧名册上，问外乡人为何寻找已经不存在的名字。桌上未拆封的公函，与来信使用同一钟楼印章。门边的旧地图仍标注着船坞。", options: [
        challenge("ask", "说明来意，请伊莱协助核查", "will", { npc: "ilai", clue: ["dock", "旧船坞地址", "伊莱确认梅拉最后在旧船坞露面。"], once: true }),
        challenge("seal", "比较印章与旧档案", "lore", { clue: ["seal", "钟楼的公函", "删档命令出自镇长办公室，使用钟楼保管的印章。"], once: true }),
        route("dock", "沿地图寻找旧船坞", "dock"),
      ] },
      { id: "dock", name: "需要保护的证人", goal: "决定怎样处理梅拉的证词", npc: "mela", text: "旧船坞里，梅拉接过信，手指在寄信人的姓名上停了很久。她承认修改过钟楼契约，只是想让镇民停止忘记彼此。她要求队伍不要立刻公布藏身处，镇长的巡逻队正往河岸走来。", reveal: [["witness", "梅拉的证词", "梅拉声称钟楼靠镇民记忆维持结界，她曾尝试修改契约。", "claim"]], options: [
        route("protect", "承诺暂时保护证人，私下调查", "square", { major: true, flag: ["witness", "protected"], promise: "在得到梅拉同意前，不公开她的藏身处。", npc: "mela" }),
        route("publish", "征得梅拉同意后公开证词", "square", { major: true, flag: ["witness", "public"], npc: "mela" }),
        challenge("history", "听梅拉讲述过去的修改尝试", "insight", { clue: ["draft", "替代契约的方向", "梅拉认为主动留下的共同见证，可能替代被取走的记忆。"], once: true }),
      ] },
      { id: "square", name: "通往钟楼的路", goal: "应对巡逻队并找到地下入口", npc: "olin", text: "巡逻队封住了广场，要求外乡人交代调查目的。钟楼侧门后有一条通往地下的楼梯；伊莱愿意提供旧维修许可，但取决于他是否信任你们。", options: [
        route("permit", "使用伊莱的维修许可通过", "undercroft", { requires: { relationship: ["ilai", 1] }, flag: ["entry", "invited"] }),
        challenge("negotiate", "与巡逻队交涉后进入地下", "will", { next: "undercroft", flag: ["entry", "bargained"], success: "巡逻队允许查明异常。", partial: "巡逻队要求你们事后公开报告。", failure: "巡逻队没收通行许可，但伊莱指出另一条无人看守的维修路，队伍仍可进入。" }),
        route("fight", "迎战阻拦的巡逻队", "undercroft", { major: true, battle: "patrol" }),
      ] },
    ] },
    { id: 2, name: "钟楼下的约定", scenes: [
      { id: "undercroft", name: "结界下的名字", goal: "验证契约真相", text: "地下墙壁上排列着成千上万的名字。一些笔画正在变淡，而水位线停在石门之外。墙角的修补记录说明，结界每年都需要更多记忆才能维持。", reveal: [["pact", "记忆与结界", "钟楼以镇民承诺的记忆维持挡水结界，近年代价正在增加。", "fact"]], options: [
        challenge("runes", "研究契约中的替代条款", "lore", { clue: ["substitute", "等效见证条款", "自愿留下、被共同保存的见证，可以替代遗忘作为结界的代价。"], once: true }),
        challenge("wall", "辨认墙上曾被抹去的人名", "insight", { clue: ["loss", "被遗忘者名单", "梅拉不是唯一被抹去的人，至少十二个家庭受到了影响。"], once: true }),
        route("council", "带着发现前往镇议事厅", "council"),
      ] },
      { id: "council", name: "秩序与真相", goal: "决定队伍支持的解决方向", npc: "olin", text: "奥林承认隐瞒了代价，却指出河水仍在城外：如果钟停了，谁来承担撤离失败的后果？梅拉提出另一种可能——不再强迫遗忘，让愿意的人主动成为见证者。", options: [
        route("keep", "支持限制代价后暂时保留旧约", "workshop", { major: true, flag: ["stance", "keep"], npc: "olin" }),
        route("break", "主张公开旧约并组织迁移", "workshop", { major: true, flag: ["stance", "break"], npc: "olin" }),
        route("renew", "寻找自愿见证的替代办法", "workshop", { major: true, flag: ["stance", "renew"], npc: "mela" }),
        challenge("people", "请镇民自己描述愿意承担的代价", "will", { clue: ["consent", "镇民的意愿", "镇民愿意参与公开的决定，但拒绝继续在不知情的情况下遗忘。"], once: true }),
      ] },
      { id: "workshop", name: "留下见证的人", goal: "准备最后一次钟声", safe: true, npc: "mela", text: "维修工坊摆着旧钟舌、迁移图和一摞空白见证纸。队伍可以为自己的方案做准备，也可以补足另一条路，避免最终只剩一个选择。", options: [
        challenge("testimony", "邀请镇民自愿写下共同见证", "will", { clue: ["testimony", "自愿见证书", "多位镇民签署了见证，并保有随时撤回的权利。"], item: ["testimony", "共同见证书"], once: true }),
        challenge("evacuation", "检查迁移路线和渡船", "body", { clue: ["evacuation", "可用的迁移路线", "旧渡船可以运送镇民到高地，路线已经标记。"], once: true }),
        route("bell", "带上准备前往钟楼", "approach"),
      ] },
    ] },
    { id: 3, name: "最后一次钟声", scenes: [
      { id: "approach", name: "钟声前的广场", goal: "让冲突中的双方让出道路", text: "广场上有人要求拆掉钟楼，也有人害怕一切改变。摇摆的钟摆像在倒数，却没有替你们做决定。你们此前公开或隐瞒的信息，已经影响了双方愿意相信谁。", options: [
        challenge("reconcile", "用已经发现的事实调解双方", "will", { next: "belfry", success: "双方愿意让队伍进入钟楼。", partial: "双方让出道路，要求所有决定必须公开。", failure: "争论没有停止，但镇民同意派见证者陪同队伍入内，不阻断最后的选择。" }),
        route("escort", "由信任队伍的证人陪同进入", "belfry", { requires: { flag: ["witness", "protected"] } }),
        route("echoes", "压制失控的回声守卫后进入", "belfry", { major: true, battle: "echoes" }),
      ] },
      { id: "belfry", name: "回声的回答", goal: "取得完整选择条件", npc: "echo", text: "钟楼回声以许多人的声音回答：它不会决定谁该忘记，只履行人们曾承诺的契约。它展示三种后果：限制旧约，停止结界并撤离，或者提交被共同保存的自愿见证。没有一种选择可以假装不付代价。", reveal: [["truth", "回声确认的契约规则", "契约可以被限制、解除或以自愿见证替代；回声不主动制造洪水。", "fact"]], options: [
        challenge("terms", "逐条核对限制与替代条款", "lore", { clue: ["terms", "可执行的条款", "保留旧约须公开年度上限；解除须组织撤离；替代须取得自愿见证并共同保存。"], once: true }),
        route("prepare", "补办现场见证与撤离准备", "decision", { clue: ["last-preparation", "最后的准备", "见证者已解释并确认各条道路的条件，未准备的路径可在现场补足，但需要承担公开监督的责任。"] }),
      ] },
      { id: "decision", name: "共同决定的代价", goal: "全队确认结局方向", npc: "echo", text: "钟舌停在最后一寸。镇民的代表等待你们公开说明选择及其代价。你们可以改变此前支持的方向，但必须解释原因，并履行仍然有效的承诺。", options: [
        { id: "keep", label: "保留结界，公开契约并限制每年的代价", major: true, ending: "keep" },
        { id: "break", label: "解除旧约，协助镇民迁往高地", major: true, ending: "break" },
        { id: "renew", label: "以自愿见证替代遗忘，共同保管新约", major: true, ending: "renew" },
      ] },
    ] },
  ],
  endings: {
    keep: "钟声再次响起，但这一次所有人都知道它意味着什么。旧约仍在，年度代价受到公开上限约束，镇民有权拒绝。你们没有让危险消失，却把决定权还给了镇民；下一年的议事会将记得是谁要求公开账本。",
    break: "钟楼安静下来。队伍协助镇民沿旧渡船路线迁上高地，低处的石街逐渐被水覆盖。人们失去了故乡的一部分，却不再被迫忘记彼此。梅拉的名字被重新写在迁移名单上。",
    renew: "新的见证被交给钟楼，也被抄写在镇民各自保管的册子里。结界继续守住河水，代价不再是被偷走的记忆，而是人们共同保存、公开承担的故事。梅拉终于可以亲自签收那封迟到的信。",
  },
};

export function sceneById(id) {
  for (const chapter of CAMPAIGN.chapters) {
    const scene = chapter.scenes.find(s => s.id === id);
    if (scene) return { ...scene, chapter: chapter.id, chapterName: chapter.name };
  }
  return null;
}

export function availableOptions(scene, state) {
  return scene.options.filter(o => {
    if (o.once && state.completed.includes(`${scene.id}:${o.id}`)) return false;
    if (o.requires?.flag && state.flags[o.requires.flag[0]] !== o.requires.flag[1]) return false;
    if (o.requires?.relationship && (state.relationships[o.requires.relationship[0]] || 0) < o.requires.relationship[1]) return false;
    return true;
  });
}

export function encounterById(id, players) {
  const count = Math.max(1, Math.min(4, players - 1));
  return {
    id, name: id === "patrol" ? "广场巡逻队" : "回声守卫", goal: "击退守卫，或全队撤离承担后续盘问，仍可继续调查。",
    enemies: Array.from({ length: count }, (_, i) => ({ id: `enemy-${i}`, name: id === "patrol" ? `巡逻员 ${i + 1}` : `回声 ${i + 1}`, hp: 4 + (players === 4 ? 1 : 0), damage: 1, attack: 1 })),
  };
}
