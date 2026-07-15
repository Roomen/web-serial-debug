// 下行下发常用指令模板
// value 为字节数组(十六进制数值)；ascii 为 ASCII 字符串(可配合 fillLen 补 0x00)；
// 查询类指令不写 value，下发时 value 为空(既查询)。
window.SK_DOWN_PRESETS = [
	{
		group: '指令操作 (0x11)',
		items: [
			{ name: '开业务猫 / 双开猫', func: '0x11', version: 1, desc: 'Tag93 开猫(业务+设备信息)',
				tlv: [{ tag: 93, items: [{ id: 0, value: [0x03] }] }] },
			{ name: '维护开猫', func: '0x11', version: 1, desc: 'Tag93 开猫(仅设备)',
				tlv: [{ tag: 93, items: [{ id: 0, value: [0x02] }] }] },
			{ name: '开阀', func: '0x11', version: 1, desc: 'Tag93 阀门控制 开阀',
				tlv: [{ tag: 93, items: [{ id: 3, value: [0x01] }] }] },
			{ name: '关阀', func: '0x11', version: 1, desc: 'Tag93 阀门控制 关阀',
				tlv: [{ tag: 93, items: [{ id: 3, value: [0x00] }] }] },
			{ name: '设备复位', func: '0x11', version: 1, desc: 'Tag93 复位(默认2秒)',
				tlv: [{ tag: 93, items: [{ id: 1, value: [0x02] }] }] },
			{ name: '业务平台注册', func: '0x11', version: 1, desc: 'Tag93 注册 业务平台',
				tlv: [{ tag: 93, items: [{ id: 7, value: [0x01] }] }] },
			{ name: '维护平台注册', func: '0x11', version: 1, desc: 'Tag93 注册 维护平台',
				tlv: [{ tag: 93, items: [{ id: 7, value: [0x02] }] }] },
		]
	},
	{
		group: '参数设置 (0x01)',
		items: [
			{ name: '配置海外业务平台IP', func: '0x01', version: 1, desc: 'Tag3 服务器地址端口 ASCII ip,端口',
				tlv: [{ tag: 3, items: [{ id: 6, ascii: '47.254.83.5,28005', fillLen: 32 }] }] },
			{ name: '配置维护平台IP', func: '0x01', version: 1, desc: 'Tag3 维护后台服务器地址端口 ASCII ip,端口',
				tlv: [{ tag: 3, items: [{ id: 21, ascii: '47.254.83.5,28005', fillLen: 32 }] }] },
		]
	},
	{
		group: '信息查询 (0x03)',
		items: [
			{ name: '查询基础数据 (读Tag1)', func: '0x03', version: 1, desc: 'Tag10 基础数据',
				tlv: [{ tag: 10, items: [{ id: 1 }] }] },
			{ name: '查询核心数据', func: '0x03', version: 1, desc: 'Tag10 核心数据',
				tlv: [{ tag: 10, items: [{ id: 2 }] }] },
			{ name: '查询终端参数', func: '0x03', version: 1, desc: 'Tag10 终端参数',
				tlv: [{ tag: 10, items: [{ id: 3 }] }] },
			{ name: '查询告警数据', func: '0x03', version: 1, desc: 'Tag10 告警数据',
				tlv: [{ tag: 10, items: [{ id: 4 }] }] },
			{ name: '查询无磁传感器参数', func: '0x03', version: 1, desc: 'Tag10 无磁传感器参数(Tag34)',
				tlv: [{ tag: 10, items: [{ id: 13 }] }] },
			{ name: '查询超声波表参数', func: '0x03', version: 1, desc: 'Tag10 超声波表参数(Tag30)',
				tlv: [{ tag: 10, items: [{ id: 30 }] }] },
			{ name: '查询阀控参数', func: '0x03', version: 1, desc: 'Tag10 阀控参数(Tag36)',
				tlv: [{ tag: 10, items: [{ id: 15 }] }] },
			{ name: '查询通信认证参数', func: '0x03', version: 1, desc: 'Tag10 通信认证参数(Tag38)',
				tlv: [{ tag: 10, items: [{ id: 22 }] }] },
			{ name: '查询设备运行信息', func: '0x03', version: 1, desc: 'Tag10 设备运行信息(Tag91)',
				tlv: [{ tag: 10, items: [{ id: 7 }] }] },
			{ name: '查询设备上行信息', func: '0x03', version: 1, desc: 'Tag10 设备上行信息(Tag92)',
				tlv: [{ tag: 10, items: [{ id: 8 }] }] },
			{ name: '查询日结数据', func: '0x03', version: 1, desc: 'Tag10 日结数据(Tag9)',
				tlv: [{ tag: 10, items: [{ id: 9 }] }] },
			{ name: '查询错误日志', func: '0x03', version: 1, desc: 'Tag10 错误日志数据(Tag254)',
				tlv: [{ tag: 10, items: [{ id: 23 }] }] },
		]
	},
]
