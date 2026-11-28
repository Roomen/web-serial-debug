// 下行下发常用指令模板 (协议版本固定v2)
// param.type: uint32le | uint16le | uint8 | enum | ascii | bcd | hexbytes | multi | largeFlow | dailyQuery | errLogQuery | histDate
// param.options: { key: label } 仅 type=enum 时有效
window.SK_DOWN_PRESETS = [
	{
		group: '参数设置-业务平台配置 (0x01)',
		items: [
			{ name: '设置上报频率', func: '0x01', desc: 'Tag3-ID9 上报频率(分钟) 须30整数倍',
				param: { label: '间隔(分钟)', type: 'uint16le', default: '1440' },
				tlv: [{ tag: 3, items: [{ id: 9 }] }] },
			{ name: '配置业务平台IP', func: '0x01', desc: 'Tag3-ID6 服务器地址端口 ASCII 建议ip/域名,端口',
				param: { label: '地址', type: 'ascii', default: '', fillLen: 32, placeholder: '建议: host,port' },
				tlv: [{ tag: 3, items: [{ id: 6 }] }] },
			{ name: '配置APN', func: '0x01', desc: 'Tag3-ID7 APN信息 ASCII 32B，留空清空',
				param: { label: 'APN', type: 'ascii', default: '', fillLen: 32, allowEmpty: true, placeholder: '留空则清空 APN (32B 全0)' },
				tlv: [{ tag: 3, items: [{ id: 7 }] }] },
			{ name: '设置上报时间参数', func: '0x01', desc: 'Tag3-ID8 起始日(1-31)+起始时(0-23)+最大上报时长(分钟,预留)',
				param: { type: 'multi', fields: [
					{ label: '起始日', type: 'uint8', default: '1', min: '1', max: '31', width: '70px' },
					{ label: '起始时', type: 'uint8', default: '0', min: '0', max: '23', width: '70px' },
					{ label: '最大时长(分)', type: 'uint16le', default: '0', min: '0', max: '65535', width: '85px' }
				] },
				tlv: [{ tag: 3, items: [{ id: 8 }] }] },
			{ name: '设置上报重发次数', func: '0x01', desc: 'Tag3-ID10 上报重发次数 0-4',
				param: { label: '次数', type: 'uint8', default: '1' },
				tlv: [{ tag: 3, items: [{ id: 10 }] }] },
			{ name: '设置上报重发间隔', func: '0x01', desc: 'Tag3-ID11 上报重发间隔(分钟)',
				param: { label: '间隔(分钟)', type: 'uint8', default: '20' },
				tlv: [{ tag: 3, items: [{ id: 11 }] }] },
			{ name: '设置通信方式', func: '0x01', desc: 'Tag3-ID23 bit7-5运营商 bit4-0协议',
				param: { type: 'multi', fields: [
					{ label: '运营商', type: 'enum', bits: [7, 5], default: '0', width: '90px', options: { 0: '通用', 1: '移动', 2: '电信', 3: '联通' } },
					{ label: '协议', type: 'enum', bits: [4, 0], default: '0', width: '115px', options: { 0: 'UDP直连', 1: 'TCP', 2: 'OneNet', 3: 'OCCoap', 4: 'AEP', 5: 'MQTT', 6: 'SSL', 7: 'DTSL', 8: 'MQTT_SSL', 9: 'LwM2M', 10: 'HTTP', 11: 'BLE' } }
				] },
				tlv: [{ tag: 3, items: [{ id: 23 }] }] },
			{ name: '设置上报定时点', func: '0x01', desc: 'Tag3-ID44 6组定时点(每组时1B+分1B) 共12B',
				param: { label: '定时点HEX', type: 'hexbytes', default: '', fillLen: 12, placeholder: '6组时分 如 0800 1200…' },
				tlv: [{ tag: 3, items: [{ id: 44 }] }] },
		]
	},
	{
		group: '参数设置-维护平台配置 (0x01)',
		items: [
			{ name: '设置维护平台上报频率', func: '0x01', desc: 'Tag3-ID22 维护后台上报频率(分钟) 须1440整数倍',
				param: { label: '间隔(分钟)', type: 'uint16le', default: '1440' },
				tlv: [{ tag: 3, items: [{ id: 22 }] }] },
			{ name: '配置维护平台IP', func: '0x01', desc: 'Tag3-ID21 维护后台地址端口 ASCII 建议ip/域名,端口',
				param: { label: '地址', type: 'ascii', default: '', fillLen: 32, placeholder: '建议: host,port' },
				tlv: [{ tag: 3, items: [{ id: 21 }] }] },
			{ name: '设置维护上报时间参数', func: '0x01', desc: 'Tag3-ID27 起始日(1-31)+起始时(0-23)+最大上报时长(分钟,预留)',
				param: { type: 'multi', fields: [
					{ label: '起始日', type: 'uint8', default: '1', min: '1', max: '31', width: '70px' },
					{ label: '起始时', type: 'uint8', default: '0', min: '0', max: '23', width: '70px' },
					{ label: '最大时长(分)', type: 'uint16le', default: '0', min: '0', max: '65535', width: '85px' }
				] },
				tlv: [{ tag: 3, items: [{ id: 27 }] }] },
			{ name: '设置维护平台连接模式', func: '0x01', desc: 'Tag3-ID40 维护平台连接模式',
				param: { label: '连接模式', type: 'enum', default: '0', options: { 0: 'IPV4', 1: 'IPV6' } },
				tlv: [{ tag: 3, items: [{ id: 40 }] }] },
		]
	},
	{
		group: '参数设置-告警阈值 (0x01)',
		items: [
			{ name: '设置过流告警阈值', func: '0x01', desc: 'Tag3-ID0 过流告警(L/h)',
				param: { label: '阈值(L/h)', type: 'uint32le', default: '3125' },
				tlv: [{ tag: 3, items: [{ id: 0 }] }] },
			{ name: '设置持续过流告警时间', func: '0x01', desc: 'Tag3-ID1 持续过流告警时间(分钟)',
				param: { label: '时间(分钟)', type: 'uint8', default: '30' },
				tlv: [{ tag: 3, items: [{ id: 1 }] }] },
			{ name: '设置反流告警阈值', func: '0x01', desc: 'Tag3-ID2 反流告警(L/h)',
				param: { label: '阈值(L/h)', type: 'uint32le', default: '40' },
				tlv: [{ tag: 3, items: [{ id: 2 }] }] },
			{ name: '设置持续反流告警时间', func: '0x01', desc: 'Tag3-ID3 持续反流告警时间(分钟)',
				param: { label: '时间(分钟)', type: 'uint8', default: '30' },
				tlv: [{ tag: 3, items: [{ id: 3 }] }] },
			{ name: '设置电压告警阈值', func: '0x01', desc: 'Tag3-ID4 电压告警阈值(0.01V)',
				param: { label: '阈值(0.01V)', type: 'uint16le', default: '0' },
				tlv: [{ tag: 3, items: [{ id: 4 }] }] },
			{ name: '设置即时告警ID', func: '0x01', desc: 'Tag3-ID5 16位位域(2B HEX)',
				param: { label: '告警位域', type: 'hexbytes', default: '', fillLen: 2, placeholder: '2B HEX 如 07 00' },
				tlv: [{ tag: 3, items: [{ id: 5 }] }] },
			{ name: '设置环境温度报警阈值', func: '0x01', desc: 'Tag3-ID33 低温+高温(℃) int8各1B',
				param: { type: 'multi', fields: [
					{ label: '低温(℃)', type: 'int8', default: '0', min: '-40', max: '85' },
					{ label: '高温(℃)', type: 'int8', default: '0', min: '-40', max: '85' }
				] },
				tlv: [{ tag: 3, items: [{ id: 33 }] }] },
		]
	},
	{
		group: '参数设置-计量参数 (0x01)',
		items: [
			{ name: '设置计量底度', func: '0x01', desc: 'Tag3-ID17 计量底度(L)',
				param: { label: '底度(L)', type: 'uint32le', default: '0' },
				tlv: [{ tag: 3, items: [{ id: 17 }] }] },
			{ name: '设置计量底度正累积(大口径)', func: '0x01', desc: 'Tag3-ID35 大口径正累积底度(m³)，下发前自动读当量换算',
				param: { label: '底度(m³)', type: 'largeFlow', default: '0', placeholder: '输入 m³，如 123.456' },
				tlv: [{ tag: 3, items: [{ id: 35 }] }] },
			{ name: '设置计量底度逆累积(大口径)', func: '0x01', desc: 'Tag3-ID36 大口径逆累积底度(m³)，下发前自动读当量换算',
				param: { label: '底度(m³)', type: 'largeFlow', default: '0', placeholder: '输入 m³，如 0' },
				tlv: [{ tag: 3, items: [{ id: 36 }] }] },
			{ name: '设置水表口径', func: '0x01', desc: 'Tag3-ID18 水表口径',
				param: { label: '口径', type: 'enum', default: '5', options: { 1: '15mm', 2: '20mm', 3: '25mm', 4: '32mm', 5: '40mm', 6: '50mm', 7: '65mm', 8: '80mm', 9: '100mm', 10: '125mm', 11: '150mm', 12: '200mm', 13: '250mm', 14: '300mm' } },
				tlv: [{ tag: 3, items: [{ id: 18 }] }] },
			{ name: '设置采集方式', func: '0x01', desc: 'Tag3-ID24 采集方式',
				param: { label: '采集方式', type: 'enum', default: '5', options: { 0: '未知', 1: '数字状态', 2: '厚膜', 3: '光电', 4: '脉冲', 5: '无磁', 6: '超声波', 7: '电磁式', 8: '摄像', 9: '总线式', 10: '无磁摄像' } },
				tlv: [{ tag: 3, items: [{ id: 24 }] }] },
			{ name: '设置脉冲形式', func: '0x01', desc: 'Tag3-ID28 脉冲形式',
				param: { label: '脉冲形式', type: 'enum', default: '5', options: { 0: '未知', 1: '单脉冲', 2: '双脉冲', 3: '正反单脉冲', 4: '方向单脉冲', 5: 'HRI', 8: '三霍尔', 9: '双霍尔' } },
				tlv: [{ tag: 3, items: [{ id: 28 }] }] },
			{ name: '设置基准水量', func: '0x01', desc: 'Tag3-ID29 基准水量',
				param: { label: '基准水量', type: 'enum', default: '0', options: { 0: '1000L/圈', 1: '100L/圈', 2: '10L/圈', 3: '1L/圈', 4: '100mL/圈', 5: '10mL/圈', 6: '1mL/圈' } },
				tlv: [{ tag: 3, items: [{ id: 29 }] }] },
			{ name: '设置基表整数位数', func: '0x01', desc: 'Tag3-ID30 基表整数位数',
				param: { label: '整数位数', type: 'uint8', default: '5' },
				tlv: [{ tag: 3, items: [{ id: 30 }] }] },
			{ name: '设置机电分离状态', func: '0x01', desc: 'Tag3-ID34 机电分离状态配置',
				param: { label: '分离状态', type: 'enum', default: '0', options: { 0: '未分离', 1: '机电分离' } },
				tlv: [{ tag: 3, items: [{ id: 34 }] }] },
			{ name: '设置计量模组开关', func: '0x01', desc: 'Tag3-ID38 计量模组启用',
				param: { label: '开关', type: 'enum', default: '1', options: { 0: '关闭', 1: '开启' } },
				tlv: [{ tag: 3, items: [{ id: 38 }] }] },
			{ name: '设置采样间隔', func: '0x01', desc: 'Tag3-ID12 数据采样间隔(分钟) 须30整数倍',
				param: { label: '间隔(分钟)', type: 'uint16le', default: '30' },
				tlv: [{ tag: 3, items: [{ id: 12 }] }] },
			{ name: '设置密集采样起始时间', func: '0x01', desc: 'Tag3-ID14 密集数据采样起始时间(小时)',
				param: { label: '小时(0-23)', type: 'uint8', default: '0' },
				tlv: [{ tag: 3, items: [{ id: 14 }] }] },
			{ name: '设置密集采样间隔', func: '0x01', desc: 'Tag3-ID15 密集数据采样间隔(分钟) 须5整数倍',
				param: { label: '间隔(分钟)', type: 'uint8', default: '5' },
				tlv: [{ tag: 3, items: [{ id: 15 }] }] },
			{ name: '设置用水量功能超时', func: '0x01', desc: 'Tag3-ID41 用水量功能超时时间(秒) 0关闭',
				param: { label: '超时(秒)', type: 'uint16le', default: '0' },
				tlv: [{ tag: 3, items: [{ id: 41 }] }] },
		]
	},
	{
		group: '参数设置-设备标识 (0x01)',
		items: [
			{ name: '设置用户表号', func: '0x01', desc: 'Tag3-ID19 用户表号 BCD小端 10B',
				param: { label: '表号(纯数字)', type: 'bcd', default: '', fillLen: 10 },
				tlv: [{ tag: 3, items: [{ id: 19 }] }] },
			{ name: '设置基表号', func: '0x01', desc: 'Tag3-ID26 基表号 BCD小端 10B',
				param: { label: '基表号(纯数字)', type: 'bcd', default: '', fillLen: 10 },
				tlv: [{ tag: 3, items: [{ id: 26 }] }] },
			{ name: '设置设备唯一编码', func: '0x01', desc: 'Tag3-ID25 设备唯一编码 BCD小端 7B',
				param: { label: '唯一编码(纯数字)', type: 'bcd', default: '', fillLen: 7 },
				tlv: [{ tag: 3, items: [{ id: 25 }] }] },
			{ name: '设置SN密钥', func: '0x01', desc: 'Tag3-ID16 SN密钥 16字节ASCII',
				param: { label: 'SN密钥', type: 'ascii', default: '', fillLen: 16 },
				tlv: [{ tag: 3, items: [{ id: 16 }] }] },
			{ name: '设置用户表号(ASCII)', func: '0x01', desc: 'Tag3-ID42 用户表号 ASCII 20B(2.89新增)',
				param: { label: '表号', type: 'ascii', default: '', fillLen: 20 },
				tlv: [{ tag: 3, items: [{ id: 42 }] }] },
			{ name: '设置基表号(ASCII)', func: '0x01', desc: 'Tag3-ID43 基表号 ASCII 20B(2.89新增)',
				param: { label: '基表号', type: 'ascii', default: '', fillLen: 20 },
				tlv: [{ tag: 3, items: [{ id: 43 }] }] },
		]
	},
	{
		group: '参数设置-设备管理 (0x01)',
		items: [
			{ name: '设置设备启用标志', func: '0x01', desc: 'Tag3-ID31 启用标志',
				param: { label: '启用标志', type: 'enum', default: '1', options: { 0: '停止', 1: '启用', 2: '运输模式' } },
				tlv: [{ tag: 3, items: [{ id: 31 }] }] },
			{ name: '设置设备校时类型', func: '0x01', desc: 'Tag3-ID32 校时类型',
				param: { label: '校时类型', type: 'enum', default: '1', options: { 0: '基站校时', 1: '服务器校时' } },
				tlv: [{ tag: 3, items: [{ id: 32 }] }] },
			{ name: '设置电池参数', func: '0x01', desc: 'Tag3-ID39 总容量+起始容量(10mAh) 各2B LE',
				param: { type: 'multi', fields: [
					{ label: '总容量(10mAh)', type: 'uint16le', default: '0', min: '0', max: '65535', width: '90px' },
					{ label: '起始容量(10mAh)', type: 'uint16le', default: '0', min: '0', max: '65535', width: '90px' }
				] },
				tlv: [{ tag: 3, items: [{ id: 39 }] }] },
			{ name: '设置结算日参数', func: '0x01', desc: 'Tag3-ID13 起始日+结算日间隔(天) 各1B',
				param: { type: 'multi', fields: [
					{ label: '起始日', type: 'uint8', default: '1', min: '1', max: '31' },
					{ label: '结算日间隔(天)', type: 'uint8', default: '1', min: '1', max: '365' }
				] },
				tlv: [{ tag: 3, items: [{ id: 13 }] }] },
			{ name: '设置水表实时时间', func: '0x01', desc: 'Tag3-ID20 水表时间 BCD YYYYMMDDhhmmss',
				param: { label: '时间', type: 'hexbytes', default: '', fillLen: 7, placeholder: '如 2508251230000' },
				tlv: [{ tag: 3, items: [{ id: 20 }] }] },
		]
	},
	{
		group: '参数设置-TAG32摄像表 (0x01)',
		items: [
			{ name: '设置坐标', func: '0x01', desc: 'Tag32-ID1 Y X1-X8 各16bit LE 共18B',
				param: { label: '坐标HEX', type: 'hexbytes', default: '', fillLen: 18, placeholder: '18B HEX (Y+X1..X8)' },
				tlv: [{ tag: 32, items: [{ id: 1 }] }] },
			{ name: '设置字轮宽', func: '0x01', desc: 'Tag32-ID2 字轮宽 0-25',
				param: { label: '宽度', type: 'uint16le', default: '0' },
				tlv: [{ tag: 32, items: [{ id: 2 }] }] },
			{ name: '设置字轮高', func: '0x01', desc: 'Tag32-ID3 字轮高 0-36',
				param: { label: '高度', type: 'uint16le', default: '0' },
				tlv: [{ tag: 32, items: [{ id: 3 }] }] },
			{ name: '设置字轮半高', func: '0x01', desc: 'Tag32-ID4 半字时高度 0-36',
				param: { label: '半高', type: 'uint16le', default: '0' },
				tlv: [{ tag: 32, items: [{ id: 4 }] }] },
			{ name: '设置模板半高', func: '0x01', desc: 'Tag32-ID5 模板半字高度 0-36',
				param: { label: '模板半高', type: 'uint16le', default: '0' },
				tlv: [{ tag: 32, items: [{ id: 5 }] }] },
			{ name: '设置字轮数', func: '0x01', desc: 'Tag32-ID6 字轮个数 0-8 默认5',
				param: { label: '字轮数', type: 'uint8', default: '5' },
				tlv: [{ tag: 32, items: [{ id: 6 }] }] },
			{ name: '设置二值化系数', func: '0x01', desc: 'Tag32-ID7 二值化系数 0-100 默认20',
				param: { label: '系数(0-100)', type: 'uint8', default: '20' },
				tlv: [{ tag: 32, items: [{ id: 7 }] }] },
			{ name: '设置代码段', func: '0x01', desc: 'Tag32-ID8 字轮模板类型 0-16',
				param: { label: '代码段', type: 'uint8', default: '0' },
				tlv: [{ tag: 32, items: [{ id: 8 }] }] },
			{ name: '设置灰度图片坐标', func: '0x01', desc: 'Tag32-ID9 相对Y坐标 0-480',
				param: { label: 'Y坐标', type: 'uint16le', default: '0' },
				tlv: [{ tag: 32, items: [{ id: 9 }] }] },
			{ name: '设置图像格式', func: '0x01', desc: 'Tag32-ID10 bit3-0格式 bit7需识别 bit6旋转',
				param: { type: 'multi', fields: [
					{ label: '格式', type: 'enum', bits: [3, 0], default: '0', options: { 0: '二值', 1: '半灰度', 2: '全灰度' } },
					{ label: '需识别', type: 'enum', bits: [7, 7], default: '0', options: { 0: '否', 1: '是' } },
					{ label: '需旋转90°', type: 'enum', bits: [6, 6], default: '0', options: { 0: '否', 1: '是' } }
				] },
				tlv: [{ tag: 32, items: [{ id: 10 }] }] },
			{ name: '设置图像品质', func: '0x01', desc: 'Tag32-ID11 压缩系数 0-100',
				param: { label: '品质(0-100)', type: 'uint8', default: '50' },
				tlv: [{ tag: 32, items: [{ id: 11 }] }] },
			{ name: '设置数据差值', func: '0x01', desc: 'Tag32-ID13 16位有符号 -32768~32767L',
				param: { label: '差值(L)', type: 'uint16le', default: '0' },
				tlv: [{ tag: 32, items: [{ id: 13 }] }] },
			{ name: '设置相对坐标X', func: '0x01', desc: 'Tag32-ID15 灰度图片相对X 0-1600',
				param: { label: 'X坐标', type: 'uint16le', default: '0' },
				tlv: [{ tag: 32, items: [{ id: 15 }] }] },
			{ name: '设置闪光灯强度', func: '0x01', desc: 'Tag32-ID16 0左边 1右边 2全开',
				param: { label: '闪光灯', type: 'enum', default: '0', options: { 0: '左边', 1: '右边', 2: '全开' } },
				tlv: [{ tag: 32, items: [{ id: 16 }] }] },
			{ name: '设置图片上传间隔', func: '0x01', desc: 'Tag32-ID17 分钟 0不上报 须1440整数倍',
				param: { label: '间隔(分钟)', type: 'uint16le', default: '0' },
				tlv: [{ tag: 32, items: [{ id: 17 }] }] },
			{ name: '设置图片旋转角度', func: '0x01', desc: 'Tag32-ID18 旋转角度(度)',
				param: { label: '角度(度)', type: 'uint8', default: '0' },
				tlv: [{ tag: 32, items: [{ id: 18 }] }] },
		]
	},
	{
		group: '参数设置-TAG33总线采集器 (0x01)',
		items: [
			{ name: '设置总线表组', func: '0x01', desc: 'Tag33-ID0 总线表组 默认0',
				param: { label: '组号', type: 'uint8', default: '0' },
				tlv: [{ tag: 33, items: [{ id: 0 }] }] },
			{ name: '设置总线表地址1', func: '0x01', desc: 'Tag33-ID1 地址BCD小端 7B (0或全FF删除)',
				param: { label: '表地址(数字)', type: 'bcd', default: '', fillLen: 7 },
				tlv: [{ tag: 33, items: [{ id: 1 }] }] },
			{ name: '设置抄表日期(旧)', func: '0x01', desc: 'Tag33-ID21 BYTE[N]=1表示日期N需抄表 32B',
				param: { label: '日期HEX', type: 'hexbytes', default: '', fillLen: 32, placeholder: '32B HEX' },
				tlv: [{ tag: 33, items: [{ id: 21 }] }] },
			{ name: '设置抄表定时点', func: '0x01', desc: 'Tag33-ID22 0-23时',
				param: { label: '定时点(时)', type: 'uint8', default: '0' },
				tlv: [{ tag: 33, items: [{ id: 22 }] }] },
			{ name: '设置启动延时', func: '0x01', desc: 'Tag33-ID23 0-10秒',
				param: { label: '延时(秒)', type: 'uint8', default: '0' },
				tlv: [{ tag: 33, items: [{ id: 23 }] }] },
			{ name: '设置抄表时长', func: '0x01', desc: 'Tag33-ID24 0-20秒',
				param: { label: '时长(秒)', type: 'uint8', default: '0' },
				tlv: [{ tag: 33, items: [{ id: 24 }] }] },
			{ name: '设置总线表集抄', func: '0x01', desc: 'Tag33-ID25 0停止 1开始集抄',
				param: { label: '集抄', type: 'enum', default: '0', options: { 0: '停止', 1: '开始集抄' } },
				tlv: [{ tag: 33, items: [{ id: 25 }] }] },
			{ name: '设置抄表日期', func: '0x01', desc: 'Tag33-ID27 bit1-31表示日期需抄表 4B位域',
				param: { label: '位域', type: 'hexbytes', default: '', fillLen: 4, placeholder: '如 00:00:00:00' },
				tlv: [{ tag: 33, items: [{ id: 27 }] }] },
			{ name: '设置周期数据上报方式', func: '0x01', desc: 'Tag33-ID29 0x90=tag90 0x94=tag94',
				param: { label: '上报方式', type: 'enum', default: '144', options: { 144: 'tag90(0x90)', 148: 'tag94(0x94)' } },
				tlv: [{ tag: 33, items: [{ id: 29 }] }] },
			{ name: '设置485总线协议ID', func: '0x01', desc: 'Tag33-ID30 0-255',
				param: { label: '协议ID', type: 'uint8', default: '0' },
				tlv: [{ tag: 33, items: [{ id: 30 }] }] },
			{ name: '设置485串口参数', func: '0x01', desc: 'Tag33-ID31 bit6数据位/bit5停止位/bit4-3校验/bit2-0波特率',
				param: { type: 'multi', fields: [
					{ label: '数据位', type: 'enum', bits: [6, 6], default: '0', options: { 0: '7位', 1: '8位' } },
					{ label: '停止位', type: 'enum', bits: [5, 5], default: '0', options: { 0: '1位', 1: '2位' } },
					{ label: '校验', type: 'enum', bits: [4, 3], default: '0', options: { 0: '无', 1: '奇校验', 2: '偶校验', 3: 'mark' } },
					{ label: '波特率', type: 'enum', bits: [2, 0], default: '0', options: { 0: '2400', 1: '4800', 2: '9600', 3: '19200', 4: '38400', 5: '57600', 6: '115200' } }
				] },
				tlv: [{ tag: 33, items: [{ id: 31 }] }] },
			{ name: '设置数据类型上报开关', func: '0x01', desc: 'Tag33-ID32 32bit位域 BIT0-13各数据',
				param: { label: '位域', type: 'hexbytes', default: '', fillLen: 4, placeholder: '如 00:00:00:00' },
				tlv: [{ tag: 33, items: [{ id: 32 }] }] },
		]
	},
	{
		group: '参数设置-TAG34无磁传感器 (0x01)',
		items: [
			{ name: '设置计量过滤模式', func: '0x01', desc: 'Tag34-ID2 计量过滤模式',
				param: { label: '过滤模式', type: 'enum', default: '0', options: { 0: '常规', 1: '开猫16ms滤波', 2: '开猫32ms滤波', 3: '开猫不计量' } },
				tlv: [{ tag: 34, items: [{ id: 2 }] }] },
			{ name: '设置SENSOR参数', func: '0x01', desc: 'Tag34-ID3 BADJ1+BADJ2+采样周期+预留+测量时长(2B)',
				param: { type: 'multi', fields: [
					{ label: 'BADJ1', type: 'uint8', default: '0', min: '0', max: '255', width: '65px' },
					{ label: 'BADJ2', type: 'uint8', default: '0', min: '0', max: '255', width: '65px' },
					{ label: '采样周期', type: 'uint8', default: '0', min: '0', max: '255', width: '65px' },
					{ label: '预留', type: 'uint8', default: '0', min: '0', max: '255', width: '65px' },
					{ label: '测量时长', type: 'uint16le', default: '0', min: '0', max: '65535', width: '80px' }
				] },
				tlv: [{ tag: 34, items: [{ id: 3 }] }] },
			{ name: '设置采样距离', func: '0x01', desc: 'Tag34-ID5 采样距离(mm)',
				param: { label: '距离(mm)', type: 'uint8', default: '0' },
				tlv: [{ tag: 34, items: [{ id: 5 }] }] },
			{ name: '设置采样频率', func: '0x01', desc: 'Tag34-ID6 采样频率(ms)',
				param: { label: '频率(ms)', type: 'uint8', default: '0' },
				tlv: [{ tag: 34, items: [{ id: 6 }] }] },
		]
	},
	{
		group: '参数设置-TAG35LoRa (0x01)',
		items: [
			{ name: '设置网络频率', func: '0x01', desc: 'Tag35-ID1 KHz 高字节在前 3B 如485MHz=07 66 88',
				param: { label: '频率', type: 'hexbytes', default: '', fillLen: 3, placeholder: '如 07:66:88' },
				tlv: [{ tag: 35, items: [{ id: 1 }] }] },
			{ name: '设置设备逻辑地址', func: '0x01', desc: 'Tag35-ID2 4字节无线逻辑地址',
				param: { label: '逻辑地址', type: 'hexbytes', default: '', fillLen: 4, placeholder: '如 00:00:00:01' },
				tlv: [{ tag: 35, items: [{ id: 2 }] }] },
			{ name: '设置网络ID', func: '0x01', desc: 'Tag35-ID3 2字节网络ID高字节在前',
				param: { label: '网络ID', type: 'hexbytes', default: '', fillLen: 2, placeholder: '如 00:01' },
				tlv: [{ tag: 35, items: [{ id: 3 }] }] },
			{ name: '设置参数配置', func: '0x01', desc: 'Tag35-ID4 8B:第三方抄表+低压关阀+除锈+通信时间',
				param: { label: '参数HEX', type: 'hexbytes', default: '', fillLen: 8, placeholder: '8B HEX' },
				tlv: [{ tag: 35, items: [{ id: 4 }] }] },
		]
	},
	{
		group: '参数设置-TAG36阀控 (0x01)',
		items: [
			{ name: '设置阀门自检日', func: '0x01', desc: 'Tag36-ID1 天 0-31 默认15',
				param: { label: '自检日', type: 'uint8', default: '15' },
				tlv: [{ tag: 36, items: [{ id: 1 }] }] },
			{ name: '设置关阀高频上报频率', func: '0x01', desc: 'Tag36-ID2 小时 1-24 默认2',
				param: { label: '频率(小时)', type: 'uint8', default: '2' },
				tlv: [{ tag: 36, items: [{ id: 2 }] }] },
			{ name: '设置关阀高频上报周期', func: '0x01', desc: 'Tag36-ID3 天 1-30 默认3',
				param: { label: '周期(天)', type: 'uint8', default: '3' },
				tlv: [{ tag: 36, items: [{ id: 3 }] }] },
			{ name: '设置应急开阀周期', func: '0x01', desc: 'Tag36-ID4 小时 1-72 默认24',
				param: { label: '周期(小时)', type: 'uint8', default: '24' },
				tlv: [{ tag: 36, items: [{ id: 4 }] }] },
			{ name: '设置应急开阀次数', func: '0x01', desc: 'Tag36-ID5 次 1-3 默认1',
				param: { label: '次数', type: 'uint8', default: '1' },
				tlv: [{ tag: 36, items: [{ id: 5 }] }] },
			{ name: '设置应急开阀功能', func: '0x01', desc: 'Tag36-ID6 1使能 0不使能 默认1',
				param: { label: '应急开阀', type: 'enum', default: '1', options: { 0: '不使能', 1: '使能' } },
				tlv: [{ tag: 36, items: [{ id: 6 }] }] },
			{ name: '设置低电压关阀功能', func: '0x01', desc: 'Tag36-ID7 1使能 0不使能 默认0',
				param: { label: '低电压关阀', type: 'enum', default: '0', options: { 0: '不使能', 1: '使能' } },
				tlv: [{ tag: 36, items: [{ id: 7 }] }] },
			{ name: '设置低电压关阀周期', func: '0x01', desc: 'Tag36-ID8 天 1-45 默认30',
				param: { label: '周期(天)', type: 'uint8', default: '30' },
				tlv: [{ tag: 36, items: [{ id: 8 }] }] },
			{ name: '设置磁干扰关阀功能', func: '0x01', desc: 'Tag36-ID9 1使能 0不使能 默认1',
				param: { label: '磁干扰关阀', type: 'enum', default: '1', options: { 0: '不使能', 1: '使能' } },
				tlv: [{ tag: 36, items: [{ id: 9 }] }] },
			{ name: '设置磁干扰关阀周期', func: '0x01', desc: 'Tag36-ID10 天 1-15 默认7',
				param: { label: '周期(天)', type: 'uint8', default: '7' },
				tlv: [{ tag: 36, items: [{ id: 10 }] }] },
			{ name: '设置关阀高频上报起止时间', func: '0x01', desc: 'Tag36-ID11 起始时+结束时 默认6-18',
				param: { type: 'multi', fields: [
					{ label: '起始时(0-23)', type: 'uint8', default: '6', min: '0', max: '23', width: '70px' },
					{ label: '结束时(0-23)', type: 'uint8', default: '18', min: '0', max: '23', width: '70px' }
				] },
				tlv: [{ tag: 36, items: [{ id: 11 }] }] },
			{ name: '设置开度调整时间参数', func: '0x01', desc: 'Tag36-ID12 频率天+4时段(起hh起mm开度) 16B',
				param: { label: '参数HEX', type: 'hexbytes', default: '', fillLen: 16, placeholder: '16B HEX' },
				tlv: [{ tag: 36, items: [{ id: 12 }] }] },
			{ name: '设置阀控功能开关', func: '0x01', desc: 'Tag36-ID13 1开启 0关闭 默认1',
				param: { label: '阀控功能', type: 'enum', default: '1', options: { 0: '关闭', 1: '开启' } },
				tlv: [{ tag: 36, items: [{ id: 13 }] }] },
			{ name: '设置应急开阀限定用水量', func: '0x01', desc: 'Tag36-ID14 单位10L',
				param: { label: '用水量(10L)', type: 'uint16le', default: '0' },
				tlv: [{ tag: 36, items: [{ id: 14 }] }] },
			{ name: '设置表端截止用水读数', func: '0x01', desc: 'Tag36-ID15 单位L 实时流量大于该值表端自动关阀 8B(2.91新增)',
				param: { label: '用水读数', type: 'hexbytes', default: '', fillLen: 8, placeholder: '如 00:00:00:00:00:00:01:00' },
				tlv: [{ tag: 36, items: [{ id: 15 }] }] },
		]
	},
	{
		group: '参数设置-TAG37蓝牙 (0x01)',
		items: [
			{ name: '设置蓝牙表名称', func: '0x01', desc: 'Tag37-ID0 蓝牙名称 ASCII 16B',
				param: { label: '名称', type: 'ascii', default: '', fillLen: 16 },
				tlv: [{ tag: 37, items: [{ id: 0 }] }] },
			{ name: '设置蓝牙表广播功能', func: '0x01', desc: 'Tag37-ID1 0关闭 1开启',
				param: { label: '广播', type: 'enum', default: '1', options: { 0: '关闭', 1: '开启' } },
				tlv: [{ tag: 37, items: [{ id: 1 }] }] },
			{ name: '设置蓝牙检索功能', func: '0x01', desc: 'Tag37-ID2 0默认检索 其他预留',
				param: { label: '检索模式', type: 'uint8', default: '0' },
				tlv: [{ tag: 37, items: [{ id: 2 }] }] },
			{ name: '设置蓝牙检索MAC', func: '0x01', desc: 'Tag37-ID3 检索蓝牙MAC 6B',
				param: { label: 'MAC地址', type: 'hexbytes', default: '', fillLen: 6, placeholder: '如 00:1A:2B:3C:4D:5E' },
				tlv: [{ tag: 37, items: [{ id: 3 }] }] },
			{ name: '设置蓝牙分体阀表号', func: '0x01', desc: 'Tag37-ID4 BCD小端 10B',
				param: { label: '表号(纯数字)', type: 'bcd', default: '', fillLen: 10 },
				tlv: [{ tag: 37, items: [{ id: 4 }] }] },
		]
	},
	{
		group: '参数设置-TAG38通讯认证 (0x01)',
		items: [
			{ name: '设置加密方式', func: '0x01', desc: 'Tag38-ID0 0不加密 1AES128 2AES256',
				param: { label: '加密方式', type: 'enum', default: '0', options: { 0: '不加密', 1: 'AES128', 2: 'AES256' } },
				tlv: [{ tag: 38, items: [{ id: 0 }] }] },
			{ name: '设置密钥Key', func: '0x01', desc: 'Tag38-ID1 通信密钥 32B AES128前16B',
				param: { label: '密钥Key', type: 'hexbytes', default: '', fillLen: 32, placeholder: 'HEX, 如 00112233...' },
				tlv: [{ tag: 38, items: [{ id: 1 }] }] },
			{ name: '设置填充方式', func: '0x01', desc: 'Tag38-ID2 0不填充',
				param: { label: '填充方式', type: 'enum', default: '0', options: { 0: '不填充' } },
				tlv: [{ tag: 38, items: [{ id: 2 }] }] },
			{ name: '设置密码工作模式', func: '0x01', desc: 'Tag38-ID3 0 ECB',
				param: { label: '工作模式', type: 'enum', default: '0', options: { 0: 'ECB' } },
				tlv: [{ tag: 38, items: [{ id: 3 }] }] },
			{ name: '设置用户账号', func: '0x01', desc: 'Tag38-ID4 用户账号 char[32]，留空清空',
				param: { label: '账号', type: 'ascii', default: '', fillLen: 32, allowEmpty: true, placeholder: '留空则清空 (32B 全0)' },
				tlv: [{ tag: 38, items: [{ id: 4 }] }] },
			{ name: '设置用户密码', func: '0x01', desc: 'Tag38-ID5 用户密码 char[32]，留空清空',
				param: { label: '密码', type: 'ascii', default: '', fillLen: 32, allowEmpty: true, placeholder: '留空则清空 (32B 全0)' },
				tlv: [{ tag: 38, items: [{ id: 5 }] }] },
			{ name: '设置动态密钥加密功能', func: '0x01', desc: 'Tag38-ID6 0不使能 1使能',
				param: { label: '动态密钥', type: 'enum', default: '0', options: { 0: '不使能', 1: '使能' } },
				tlv: [{ tag: 38, items: [{ id: 6 }] }] },
		]
	},
	{
		group: '参数设置-TAG39告警 (0x01)',
		items: [
			{ name: '设置突发大用水告警参数', func: '0x01', desc: 'Tag39-ID1 使能1B+持续时间2B(分)+阈值4B(L)+判断阈值1B(L)',
				param: { type: 'multi', fields: [
					{ label: '使能', type: 'enum', default: '1', width: '80px', options: { 0: '关闭', 1: '开启' } },
					{ label: '持续时间(分)', type: 'uint16le', default: '0', min: '0', max: '65535', width: '80px' },
					{ label: '阈值(L)', type: 'uint32le', default: '0', min: '0', width: '90px' },
					{ label: '判断阈值(L)', type: 'uint8', default: '0', min: '0', max: '255', width: '70px' }
				] },
				tlv: [{ tag: 39, items: [{ id: 1 }] }] },
			{ name: '设置分时段低流量告警参数', func: '0x01', desc: 'Tag39-ID2 使能1B+4分段(起止2B+流量4B) 33B',
				param: { label: '参数HEX', type: 'hexbytes', default: '', fillLen: 33, placeholder: '33B HEX' },
				tlv: [{ tag: 39, items: [{ id: 2 }] }] },
			{ name: '设置持续小流量告警参数', func: '0x01', desc: 'Tag39-ID3 持续时间2B(min)+流量阈值2B(L)',
				param: { type: 'multi', fields: [
					{ label: '持续时间(分)', type: 'uint16le', default: '0', min: '0', max: '65535', width: '85px' },
					{ label: '流量阈值(L)', type: 'uint16le', default: '0', min: '0', max: '65535', width: '85px' }
				] },
				tlv: [{ tag: 39, items: [{ id: 3 }] }] },
			{ name: '设置逆流阶段预警阈值参数', func: '0x01', desc: 'Tag39-ID4 使能1B+一级/二级/三级阈值各4B(L) 13B',
				param: { type: 'multi', fields: [
					{ label: '使能', type: 'enum', default: '1', width: '80px', options: { 0: '关闭', 1: '开启' } },
					{ label: '一级(L)', type: 'uint32le', default: '10', min: '0', width: '80px' },
					{ label: '二级(L)', type: 'uint32le', default: '50', min: '0', width: '80px' },
					{ label: '三级(L)', type: 'uint32le', default: '100', min: '0', width: '80px' }
				] },
				tlv: [{ tag: 39, items: [{ id: 4 }] }] },
		]
	},
	{
		group: '参数设置-TAG40蜂窝搜网 (0x01)',
		items: [
			{ name: '设置锁定运营商', func: '0x01', desc: 'Tag40-ID1，5 或 6 位 MCC+MNC，留空自动选网',
				param: { label: 'MCC+MNC', type: 'cellularLock', field: 'operator', placeholder: '留空不锁运营商', inputMode: 'numeric' },
				tlv: [{ tag: 40, items: [{ id: 1 }] }] },
			{ name: '设置锁定频段', func: '0x01', desc: 'Tag40-ID2，最多 8 个十进制频段号，留空不锁频段；与频点互斥，由设备清除另一项',
				param: { label: '频段', type: 'cellularLock', field: 'bands', placeholder: '如 3, 8, 20；留空不锁频段' },
				tlv: [{ tag: 40, items: [{ id: 2 }] }] },
			{ name: '设置锁定频点', func: '0x01', desc: 'Tag40-ID3，EARFCN 1–262143，留空不锁频点；与频段互斥，由设备清除另一项',
				param: { label: 'EARFCN', type: 'cellularLock', field: 'earfcn', placeholder: '留空不锁频点', inputMode: 'numeric' },
				tlv: [{ tag: 40, items: [{ id: 3 }] }] },
		]
	},
	{
		group: '参数设置-TAG30超声波 (0x01)',
		items: [
			{ name: '设置流量点', func: '0x01', desc: 'Tag30-ID1 7个4字节流量值 28B',
				param: { label: '流量点HEX', type: 'hexbytes', default: '', fillLen: 28, placeholder: '28B HEX' },
				tlv: [{ tag: 30, items: [{ id: 1 }] }] },
			{ name: '设置正向时差', func: '0x01', desc: 'Tag30-ID2 7个4字节正向值 28B',
				param: { label: '正向时差HEX', type: 'hexbytes', default: '', fillLen: 28, placeholder: '28B HEX' },
				tlv: [{ tag: 30, items: [{ id: 2 }] }] },
			{ name: '设置反向时差', func: '0x01', desc: 'Tag30-ID3 7个4字节反向值 28B',
				param: { label: '反向时差HEX', type: 'hexbytes', default: '', fillLen: 28, placeholder: '28B HEX' },
				tlv: [{ tag: 30, items: [{ id: 3 }] }] },
			{ name: '设置通道1声速比值、补偿值', func: '0x01', desc: 'Tag30-ID4 声速比值2B+补偿值2B',
				param: { type: 'multi', fields: [
					{ label: '声速比值', type: 'uint16le', default: '0', width: '85px' },
					{ label: '补偿值', type: 'uint16le', default: '0', width: '85px' }
				] },
				tlv: [{ tag: 30, items: [{ id: 4 }] }] },
			{ name: '设置通道2声速比值、补偿值', func: '0x01', desc: 'Tag30-ID5 声速比值2B+补偿值2B',
				param: { type: 'multi', fields: [
					{ label: '声速比值', type: 'uint16le', default: '0', width: '85px' },
					{ label: '补偿值', type: 'uint16le', default: '0', width: '85px' }
				] },
				tlv: [{ tag: 30, items: [{ id: 5 }] }] },
			{ name: '设置通道3声速比值、补偿值', func: '0x01', desc: 'Tag30-ID6 声速比值2B+补偿值2B',
				param: { type: 'multi', fields: [
					{ label: '声速比值', type: 'uint16le', default: '0', width: '85px' },
					{ label: '补偿值', type: 'uint16le', default: '0', width: '85px' }
				] },
				tlv: [{ tag: 30, items: [{ id: 6 }] }] },
			{ name: '设置通道4声速比值、补偿值', func: '0x01', desc: 'Tag30-ID7 声速比值2B+补偿值2B',
				param: { type: 'multi', fields: [
					{ label: '声速比值', type: 'uint16le', default: '0', width: '85px' },
					{ label: '补偿值', type: 'uint16le', default: '0', width: '85px' }
				] },
				tlv: [{ tag: 30, items: [{ id: 7 }] }] },
			{ name: '设置窗口延时时间', func: '0x01', desc: 'Tag30-ID8 0.1us',
				param: { label: '延时(0.1us)', type: 'uint16le', default: '0' },
				tlv: [{ tag: 30, items: [{ id: 8 }] }] },
			{ name: '设置流量补偿值', func: '0x01', desc: 'Tag30-ID9 高温/常温/低温 各2B',
				param: { type: 'multi', fields: [
					{ label: '高温', type: 'uint16le', default: '0', width: '75px' },
					{ label: '常温', type: 'uint16le', default: '0', width: '75px' },
					{ label: '低温', type: 'uint16le', default: '0', width: '75px' }
				] },
				tlv: [{ tag: 30, items: [{ id: 9 }] }] },
			{ name: '设置阈值电压', func: '0x01', desc: 'Tag30-ID10 范围10-250',
				param: { label: '阈值电压', type: 'uint8', default: '10' },
				tlv: [{ tag: 30, items: [{ id: 10 }] }] },
			{ name: '设置压力零点值(1)', func: '0x01', desc: 'Tag30-ID11 kPa',
				param: { label: '零点值(kPa)', type: 'uint16le', default: '0' },
				tlv: [{ tag: 30, items: [{ id: 11 }] }] },
			{ name: '设置压力零点值(2)', func: '0x01', desc: 'Tag30-ID12 kPa',
				param: { label: '零点值(kPa)', type: 'uint16le', default: '0' },
				tlv: [{ tag: 30, items: [{ id: 12 }] }] },
			{ name: '设置压力启用状态', func: '0x01', desc: 'Tag30-ID13 1启动 0未启用',
				param: { label: '启用状态', type: 'enum', default: '0', options: { 0: '未启用', 1: '启动' } },
				tlv: [{ tag: 30, items: [{ id: 13 }] }] },
			{ name: '设置通道初始时间', func: '0x01', desc: 'Tag30-ID14 通道1-4初始时间各2B',
				param: { type: 'multi', fields: [
					{ label: '通道1', type: 'uint16le', default: '0', width: '70px' },
					{ label: '通道2', type: 'uint16le', default: '0', width: '70px' },
					{ label: '通道3', type: 'uint16le', default: '0', width: '70px' },
					{ label: '通道4', type: 'uint16le', default: '0', width: '70px' }
				] },
				tlv: [{ tag: 30, items: [{ id: 14 }] }] },
			{ name: '设置始动静态阈值', func: '0x01', desc: 'Tag30-ID15 10ps',
				param: { label: '阈值(10ps)', type: 'uint16le', default: '0' },
				tlv: [{ tag: 30, items: [{ id: 15 }] }] },
			{ name: '设置始动流速阈值', func: '0x01', desc: 'Tag30-ID16 L/h',
				param: { label: '阈值(L/h)', type: 'uint16le', default: '0' },
				tlv: [{ tag: 30, items: [{ id: 16 }] }] },
			{ name: '设置显示方式', func: '0x01', desc: 'Tag30-ID17 0净=正-反 1净=正+反 2净=正',
				param: { label: '显示方式', type: 'enum', default: '0', options: { 0: '净=正-反', 1: '净=正+反', 2: '净=正' } },
				tlv: [{ tag: 30, items: [{ id: 17 }] }] },
			{ name: '设置显示范围', func: '0x01', desc: 'Tag30-ID18 0电子式带正负 1机械式倒流减至全9',
				param: { label: '显示范围', type: 'enum', default: '0', options: { 0: '电子式带正负', 1: '机械式倒流减至全9' } },
				tlv: [{ tag: 30, items: [{ id: 18 }] }] },
			{ name: '设置东剑管道正流系数', func: '0x01', desc: 'Tag30-ID19 float×7 小到大流量 28B',
				param: { label: '正流系数HEX', type: 'hexbytes', default: '', fillLen: 28, placeholder: '28B HEX' },
				tlv: [{ tag: 30, items: [{ id: 19 }] }] },
			{ name: '设置东剑管道反流系数', func: '0x01', desc: 'Tag30-ID20 float×7 小到大流量 28B',
				param: { label: '反流系数HEX', type: 'hexbytes', default: '', fillLen: 28, placeholder: '28B HEX' },
				tlv: [{ tag: 30, items: [{ id: 20 }] }] },
		]
	},
	{
		group: '参数设置-TAG64渗漏仪 (0x01)',
		items: [
			{ name: '设置探头地址', func: '0x01', desc: 'Tag64-ID0 传感器ID 4B',
				param: { label: '探头地址', type: 'hexbytes', default: '', fillLen: 4, placeholder: '如 00:00:00:01' },
				tlv: [{ tag: 64, items: [{ id: 0 }] }] },
			{ name: '设置音频采集时间', func: '0x01', desc: 'Tag64-ID1 整时点 0-23',
				param: { label: '时点(0-23)', type: 'uint8', default: '0' },
				tlv: [{ tag: 64, items: [{ id: 1 }] }] },
			{ name: '设置采集持续时间', func: '0x01', desc: 'Tag64-ID2 分钟 默认120 最小5 最大240',
				param: { label: '时长(分钟)', type: 'uint8', default: '120' },
				tlv: [{ tag: 64, items: [{ id: 2 }] }] },
			{ name: '设置AMP增益', func: '0x01', desc: 'Tag64-ID3 增益高低',
				param: { label: 'AMP', type: 'enum', default: '0', options: { 0: '低', 1: '高' } },
				tlv: [{ tag: 64, items: [{ id: 3 }] }] },
			{ name: '设置增益开关', func: '0x01', desc: 'Tag64-ID4 增益开关',
				param: { label: '增益开关', type: 'enum', default: '0', options: { 0: '关闭', 1: '开启' } },
				tlv: [{ tag: 64, items: [{ id: 4 }] }] },
			{ name: '设置湿度报警阈值', func: '0x01', desc: 'Tag64-ID5 0-100% 大于该值报警',
				param: { label: '阈值(%)', type: 'uint8', default: '90' },
				tlv: [{ tag: 64, items: [{ id: 5 }] }] },
			{ name: '设置压力报警阈值', func: '0x01', desc: 'Tag64-ID6 小于该值报警',
				param: { label: '阈值', type: 'uint16le', default: '0' },
				tlv: [{ tag: 64, items: [{ id: 6 }] }] },
			{ name: '设置噪声上传使能', func: '0x01', desc: 'Tag64-ID7 0x00不需要上报',
				param: { label: '使能', type: 'enum', default: '1', options: { 0: '不上报', 1: '上报' } },
				tlv: [{ tag: 64, items: [{ id: 7 }] }] },
			{ name: '设置音频上传使能', func: '0x01', desc: 'Tag64-ID8 0x00不需要上报',
				param: { label: '使能', type: 'enum', default: '1', options: { 0: '不上报', 1: '上报' } },
				tlv: [{ tag: 64, items: [{ id: 8 }] }] },
			{ name: '设置经纬度', func: '0x01', desc: 'Tag64-ID9 ASCII 坐标系 经度|纬度 32B',
				param: { label: '经纬度', type: 'ascii', default: '', fillLen: 32 },
				tlv: [{ tag: 64, items: [{ id: 9 }] }] },
		]
	},
	{
		group: '指令操作 (0x11)',
		items: [
			{ name: '开猫-业务数据', func: '0x11', desc: 'Tag93-ID0=1 核心+告警',
				tlv: [{ tag: 93, items: [{ id: 0, value: [0x01] }] }] },
			{ name: '开猫-设备信息', func: '0x11', desc: 'Tag93-ID0=2 基础+参数+运行+上行',
				tlv: [{ tag: 93, items: [{ id: 0, value: [0x02] }] }] },
			{ name: '开猫-全部', func: '0x11', desc: 'Tag93-ID0=3 业务数据+设备信息',
				tlv: [{ tag: 93, items: [{ id: 0, value: [0x03] }] }] },
			{ name: '开阀', func: '0x11', desc: 'Tag93 阀门控制 开阀',
				tlv: [{ tag: 93, items: [{ id: 3, value: [0x01] }] }] },
			{ name: '关阀', func: '0x11', desc: 'Tag93 阀门控制 关阀',
				tlv: [{ tag: 93, items: [{ id: 3, value: [0x00] }] }] },
			{ name: '设备复位', func: '0x11', desc: 'Tag93 复位',
				param: { label: '延时(秒)', type: 'uint8', default: '2' },
				tlv: [{ tag: 93, items: [{ id: 1 }] }] },
			{ name: '初始化', func: '0x11', desc: 'Tag93 初始化(协议0-3; FlowLogic C 现为1-4请按设备确认)',
				param: { label: '初始化类型', type: 'enum', default: '0', options: { 0: '数据初始化', 1: '参数初始化', 2: '恢复出厂', 3: '信息初始化' } },
				tlv: [{ tag: 93, items: [{ id: 2 }] }] },
			{ name: '总线表阀门控制', func: '0x11', desc: 'Tag93-ID10 表数1B+每表(地址7B BCD小端+动作1B)',
				param: { label: '控制HEX', type: 'hexbytes', default: '', placeholder: '表数1B+地址7B+动作1B' },
				tlv: [{ tag: 93, items: [{ id: 10 }] }] },
			{ name: '阀门开阀度控制', func: '0x11', desc: 'Tag93-ID17 开阀度0-100',
				param: { label: '开阀度(0-100)', type: 'uint8', default: '100' },
				tlv: [{ tag: 93, items: [{ id: 17 }] }] },
			{ name: '休眠', func: '0x11', desc: 'Tag93-ID12 整机休眠',
				tlv: [{ tag: 93, items: [{ id: 12, value: [0x01] }] }] },
			{ name: '传感器校准', func: '0x11', desc: 'Tag93-ID8 传感器编号(1-255)',
				param: { label: '传感器编号', type: 'uint8', default: '1' },
				tlv: [{ tag: 93, items: [{ id: 8 }] }] },
			{ name: '除锈', func: '0x11', desc: 'Tag93 阀门控制 除锈',
				tlv: [{ tag: 93, items: [{ id: 3, value: [0x03] }] }] },
			{ name: '开关到位检测', func: '0x11', desc: 'Tag93 阀门控制 开关到位检测',
				tlv: [{ tag: 93, items: [{ id: 3, value: [0x04] }] }] },
			{ name: '启动模组FOTA', func: '0x11', desc: 'Tag93-ID4 预留(文档未定义取值,按需填写)',
				param: { label: '值', type: 'uint8', default: '1' },
				tlv: [{ tag: 93, items: [{ id: 4 }] }] },
			{ name: '总线表底度设置', func: '0x11', desc: 'Tag93-ID5 表数量1B+每表(地址7B+底度4B L)',
				param: { label: '底度HEX', type: 'hexbytes', default: '', placeholder: '表数1B+地址7B+底度4B' },
				tlv: [{ tag: 93, items: [{ id: 5 }] }] },
			{ name: '摄像表自动定位', func: '0x11', desc: 'Tag93-ID6=1 自动定位',
				tlv: [{ tag: 93, items: [{ id: 6, value: [0x01] }] }] },
			{ name: '注册', func: '0x11', desc: 'Tag93-ID7 1业务平台 2维护平台 3业务&维护平台',
				param: { label: '注册对象', type: 'enum', default: '3', options: { 1: '业务平台', 2: '维护平台', 3: '业务&维护平台' } },
				tlv: [{ tag: 93, items: [{ id: 7 }] }] },
			{ name: '摄像表抄实时数据', func: '0x11', desc: 'Tag93-ID9=1 读摄像数据',
				tlv: [{ tag: 93, items: [{ id: 9, value: [0x01] }] }] },
			{ name: '摄像校准无磁', func: '0x11', desc: 'Tag93-ID11 文档未标注取值,按需填写',
				param: { label: '值', type: 'uint8', default: '1' },
				tlv: [{ tag: 93, items: [{ id: 11 }] }] },
			{ name: '渗漏仪传感器唤醒', func: '0x11', desc: 'Tag93-ID13=1',
				tlv: [{ tag: 93, items: [{ id: 13, value: [0x01] }] }] },
			{ name: '渗漏仪传感器休眠', func: '0x11', desc: 'Tag93-ID14=1',
				tlv: [{ tag: 93, items: [{ id: 14, value: [0x01] }] }] },
			{ name: '渗漏仪传感器噪声校准参数复位', func: '0x11', desc: 'Tag93-ID15=0xFF',
				tlv: [{ tag: 93, items: [{ id: 15, value: [0xff] }] }] },
			{ name: '渗漏仪传感器立刻采样音频', func: '0x11', desc: 'Tag93-ID16=1 采样5S',
				tlv: [{ tag: 93, items: [{ id: 16, value: [0x01] }] }] },
			{ name: '阀门开关阀超时校准', func: '0x11', desc: 'Tag93-ID18 预留(文档未定义取值,按需填写)',
				param: { label: '值', type: 'uint8', default: '0' },
				tlv: [{ tag: 93, items: [{ id: 18 }] }] },
			{ name: '屏幕轮显', func: '0x11', desc: 'Tag93-ID19 预留字段(BYTE), 默认0',
				param: { label: '值', type: 'uint8', default: '0' },
				tlv: [{ tag: 93, items: [{ id: 19 }] }] },
		]
	},
	{
		group: '信息查询 (0x03)',
		items: [
			{ name: '查询基础数据', func: '0x03', desc: 'Tag1 基础数据',
				tlv: [{ tag: 10, items: [{ id: 1 }] }] },
			{ name: '查询核心数据', func: '0x03', desc: 'Tag2 核心数据',
				tlv: [{ tag: 10, items: [{ id: 2 }] }] },
			{ name: '查询终端参数', func: '0x03', desc: 'Tag3 终端参数',
				tlv: [{ tag: 10, items: [{ id: 3 }] }] },
			{ name: '查询告警数据', func: '0x03', desc: 'Tag4 告警数据',
				tlv: [{ tag: 10, items: [{ id: 4 }] }] },
			{ name: '查询无磁传感器参数', func: '0x03', desc: 'Tag34 无磁传感器',
				tlv: [{ tag: 10, items: [{ id: 13 }] }] },
			{ name: '查询超声波表参数', func: '0x03', desc: 'Tag30 超声波表',
				tlv: [{ tag: 10, items: [{ id: 30 }] }] },
			{ name: '查询超声波表状态参数', func: '0x03', desc: 'Tag31 超声波状态',
				tlv: [{ tag: 10, items: [{ id: 31 }] }] },
			{ name: '查询阀控参数', func: '0x03', desc: 'Tag36 阀控',
				tlv: [{ tag: 10, items: [{ id: 15 }] }] },
			{ name: '查询通信认证参数', func: '0x03', desc: 'Tag38 通信认证',
				tlv: [{ tag: 10, items: [{ id: 22 }] }] },
			{ name: '查询蜂窝搜网参数', func: '0x03', desc: 'Tag40 读取锁定配置、最近驻网信息（运营商、频段、频点）及搜网状态与诊断信息',
				tlv: [{ tag: 10, items: [{ id: 40 }] }] },
			{ name: '查询设备运行信息', func: '0x03', desc: 'Tag91 运行信息',
				tlv: [{ tag: 10, items: [{ id: 7 }] }] },
			{ name: '查询设备上行信息', func: '0x03', desc: 'Tag92 上行信息',
				tlv: [{ tag: 10, items: [{ id: 8 }] }] },
			{ name: '查询错误日志', func: '0x03', desc: 'Tag10-ID23 起始时间6B BCD+条数',
				param: { label: '条数', type: 'errLogQuery', default: '4' },
				tlv: [{ tag: 10, items: [{ id: 23 }] }] },
			{ name: '查询摄像表参数', func: '0x03', desc: 'Tag32 摄像表',
				tlv: [{ tag: 10, items: [{ id: 10 }] }] },
			{ name: '查询总线采集器参数', func: '0x03', desc: 'Tag33 总线采集器',
				tlv: [{ tag: 10, items: [{ id: 11 }] }] },
			{ name: '查询蓝牙表参数', func: '0x03', desc: 'Tag37 蓝牙',
				tlv: [{ tag: 10, items: [{ id: 18 }] }] },
			{ name: '查询指定ID数据', func: '0x03', desc: 'Tag10-ID0 2B一组(tag+id) 最多16组',
				param: { label: 'Tag+ID HEX', type: 'hexbytes', default: '', placeholder: '如 03 1D (查Tag3-ID29)' },
				tlv: [{ tag: 10, items: [{ id: 0 }] }] },
			// 历史数据(最长可查近2个月): 日冻结按月片 + 指定日历史
			{ name: '查询历史冻结数据', func: '0x03',
				desc: 'Tag10-ID24 日冻结累计(Tag5间隔1440min) 近2个月分两片查询',
				param: {
					label: '月份片',
					type: 'enum',
					default: '0',
					options: {
						0: '第1月·近30日(含今日)',
						1: '第2月·往前31~60日'
					}
				},
				tlv: [{ tag: 10, items: [{ id: 24 }] }] },
			{ name: '查询历史数据(指定日)', func: '0x03',
				desc: 'Tag10-ID5 指定日YYYYMMDDhhmmss 核心/周期/告警 可选密集 近2个月可选',
				param: {
					label: '日期',
					type: 'histDate',
					maxDays: 60,
					default: ''
				},
				tlv: [{ tag: 10, items: [{ id: 5 }] }] },
			{ name: '查询日结数据', func: '0x03', desc: 'Tag10-ID9 起始日YYMMDD(BCD)+个数 最多约60日',
				param: { label: '天数', type: 'dailyQuery', default: '30', max: 60 },
				tlv: [{ tag: 10, items: [{ id: 9 }] }] },
			{ name: '查询LoRa参数', func: '0x03', desc: 'Tag35 LoRa/LoRaWAN',
				tlv: [{ tag: 10, items: [{ id: 35 }] }] },
			{ name: '查询总线采集器数据', func: '0x03', desc: 'Tag10-ID12 0全表 1-64对应表 响应Tag90',
				param: { label: '表号(0=全)', type: 'uint8', default: '0' },
				tlv: [{ tag: 10, items: [{ id: 12 }] }] },
			{ name: '查询渗漏仪运行参数', func: '0x03', desc: 'Tag64 渗漏仪',
				tlv: [{ tag: 10, items: [{ id: 19 }] }] },
			{ name: '查询渗漏仪噪声数据', func: '0x03', desc: 'Tag62 噪声',
				tlv: [{ tag: 10, items: [{ id: 20 }] }] },
			{ name: '查询图片数据', func: '0x03', desc: 'Tag10-ID6 1二值 2标准 3识别+二值 响应Tag8',
				param: {
					label: '类型',
					type: 'enum',
					default: '1',
					options: { 1: '二值压缩', 2: '标准图片', 3: '识别+二值' }
				},
				tlv: [{ tag: 10, items: [{ id: 6 }] }] },
			{ name: '查询总线采集器底度(批量)', func: '0x03', desc: 'Tag10-ID16 当前第几包(索引0起) 响应Tag33-ID26',
				param: { label: '包序号', type: 'uint8', default: '0' },
				tlv: [{ tag: 10, items: [{ id: 16 }] }] },
			{ name: '查询总线采集器地址(批量)', func: '0x03', desc: 'Tag10-ID17 当前第几包(索引0起) 响应Tag33-ID28',
				param: { label: '包序号', type: 'uint8', default: '0' },
				tlv: [{ tag: 10, items: [{ id: 17 }] }] },
			{ name: '查询渗漏仪音频数据', func: '0x03', desc: 'Tag10-ID21 分体/一体+日期/最新+包序号 响应Tag63',
				param: { type: 'multi', fields: [
					{ label: '类型', type: 'enum', default: '0', width: '80px', options: { 0: '分体', 1: '一体' } },
					{ label: '日期/最新', type: 'uint8', default: '0', min: '0', max: '255', width: '75px' },
					{ label: '包序号', type: 'uint16le', default: '0', min: '0', max: '65535', width: '80px' }
				] },
				tlv: [{ tag: 10, items: [{ id: 21 }] }] },
			{ name: '查询LoraWan参数', func: '0x03', desc: 'Tag10-ID14 文档标注"响应返回待定", 实际应答格式未定',
				tlv: [{ tag: 10, items: [{ id: 14 }] }] },
			{ name: '查询eSIM信息', func: '0x03', desc: 'Tag10-ID66 查询EID/Profile列表/事务状态/待发通知摘要 响应Tag66',
				tlv: [{ tag: 10, items: [{ id: 66 }] }] },
		]
	},
]

// SEK 常用指令纯函数工具：大口径底度(m³)按基准水量(当量)换算、指令搜索过滤
window.SK_PRESET_CODEC = (function () {
	'use strict'
	const BASE_WATER_LABEL = {
		0: '1000L/圈', 1: '100L/圈', 2: '10L/圈', 3: '1L/圈',
		4: '100mL/圈', 5: '10mL/圈', 6: '1mL/圈'
	}
	const MAX_U56 = (1n << 56n) - 1n

	// m³(十进制字符串或数字) + 基准水量码(0..6, 1m³ = 10^code 单位) → BYTE[1+7](0x00状态 + 7B无符号LE)
	function largeFlowM3ToBytes(m3Input, baseCode) {
		const code = Number(baseCode)
		if (!Number.isInteger(code) || code < 0 || code > 6) {
			return { error: '无效的基准水量码: ' + baseCode }
		}
		const s = String(m3Input == null ? '' : m3Input).trim()
		if (!s) return { error: '请输入底度(m³)' }
		const m = s.match(/^(\d+)(?:\.(\d+))?$/)
		if (!m) return { error: '底度格式无效，请输入非负数字(m³)' }
		const intPart = m[1]
		const fracPart = m[2] || ''
		let units
		if (fracPart.length <= code) {
			const scaled = intPart + fracPart.padEnd(code, '0')
			units = BigInt(scaled)
		} else {
			const keep = fracPart.slice(0, code)
			const nextDigit = fracPart.charCodeAt(code) - 48
			units = BigInt(intPart + keep) + (nextDigit >= 5 ? 1n : 0n)
		}
		if (units > MAX_U56) {
			return { error: '换算后的计数值超出 7 字节无符号整数上限' }
		}
		const bytes = [0x00]
		let tmp = units
		for (let i = 0; i < 7; i++) {
			bytes.push(Number(tmp & 0xffn))
			tmp >>= 8n
		}
		return {
			bytes: bytes,
			units: units.toString(),
			baseCode: code,
			baseLabel: BASE_WATER_LABEL[code] || String(code)
		}
	}

	function settingRange(param) {
		const type = param.type === 'enum' ? (param.valueType || 'uint8') : param.type
		const match = /^(u?)int(8|16|32)(?:le|be)?$/.exec(type)
		if (!match) return null
		const signed = !match[1]
		const limit = 2 ** (+match[2] - (signed ? 1 : 0))
		const lo = signed ? -limit : 0
		const hi = limit - 1
		return {
			min: param.min == null ? lo : Math.max(lo, +param.min),
			max: param.max == null ? hi : Math.min(hi, +param.max),
		}
	}

	function settingNumber(param, input) {
		const range = settingRange(param)
		const value = /^-?\d+$/.test(String(input).trim()) ? Number(input) : NaN
		if (!range || !Number.isInteger(value) || value < range.min || value > range.max || (param.options && !Object.prototype.hasOwnProperty.call(param.options, value))) {
			throw new Error((param.label || '数值') + '超出范围或不是有效选项')
		}
		return value
	}

	function settingBytes(param, value) {
		const codec = window.ProtocolDownlink
		if (!codec) throw new Error('参数编码器未加载')
		if (param.type === 'multi') {
			if (!Array.isArray(value) || value.length !== param.fields.length) throw new Error('参数项数不匹配')
			return codec.encodeMultiFields(param.fields, param.fields.map(function (part, index) { return settingNumber(part, value[index]) }))
		}
		if (param.type === 'ascii') {
			const length = param.fillLen || param.length
			if (typeof value !== 'string' || /[^\x20-\x7e]/.test(value) || (length != null && value.length > length)) throw new Error('请输入长度合规的可打印 ASCII')
			return codec.encodeFieldValue(param.type, value, Object.assign({ allowEmpty: true }, param))
		}
		if (param.type === 'bcd') {
			const length = param.fillLen || param.length
			const digits = typeof value === 'string' ? value.trim() : ''
			if (!/^\d+$/.test(digits) || (length != null && digits.length > length * 2)) throw new Error('请输入长度合规的纯数字 BCD')
			return codec.encodeFieldValue(param.type, digits, param)
		}
		if (param.type === 'hexbytes') {
			const length = param.fillLen || param.length
			const raw = typeof value === 'string' ? value.trim() : ''
			if (!raw || /[^0-9a-fA-F\s:-]/.test(raw)) throw new Error('请输入合法的十六进制字节')
			const hex = raw.replace(/[\s:-]/g, '')
			if (!hex.length || hex.length % 2 !== 0 || (length != null && hex.length / 2 > length)) throw new Error('请输入长度合规的偶数位十六进制字节')
			return codec.encodeFieldValue(param.type, hex, param)
		}
		return codec.encodeFieldValue(param.type, settingNumber(param, value), param)
	}

	function unitsToM3(units, baseCode) {
		const digits = String(units).padStart(baseCode + 1, '0')
		return baseCode ? (digits.slice(0, -baseCode) + '.' + digits.slice(-baseCode)).replace(/\.?0+$/, '') : digits
	}

	// 按功能码和关键字(空格分隔多词全匹配)过滤常用指令分组
	function filterPresets(presets, funcCode, query) {
		const list = Array.isArray(presets) ? presets : []
		const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
		const out = []
		for (let i = 0; i < list.length; i++) {
			const grp = list[i]
			const grpText = String(grp.group || '').toLowerCase()
			const filtered = (grp.items || []).filter(function (it) {
				if (funcCode && it.func !== funcCode) return false
				if (!tokens.length) return true
				const hay = (String(it.name || '') + ' ' + String(it.desc || '') + ' ' + grpText).toLowerCase()
				for (let k = 0; k < tokens.length; k++) {
					if (hay.indexOf(tokens[k]) < 0) return false
				}
				return true
			})
			if (filtered.length) out.push({ grp: grp, filtered: filtered })
		}
		return out
	}

	function cellularLockToBytes(field, input) {
		const text = String(input == null ? '' : input).trim()
		if (field === 'operator') {
			if (text && !/^\d{5,6}$/.test(text)) return { error: '请输入 5 或 6 位数字，或留空不锁' }
			return { bytes: Array.from(text.padEnd(6, '\0'), digit => digit.charCodeAt(0)) }
		}
		if (field === 'bands') {
			const bands = text ? text.split(/\s*[,，]\s*|\s+/) : []
			if (bands.length > 8 || bands.some(band => !/^\d{1,3}$/.test(band) || Number(band) < 1 || Number(band) > 255)) {
				return { error: '请输入最多 8 个 1–255 的频段号，用逗号或空格分隔，或留空不锁' }
			}
			return { bytes: bands.map(Number).concat(Array(8 - bands.length).fill(0)) }
		}
		if (field === 'earfcn') {
			const value = Number(text)
			if (text && (!/^\d+$/.test(text) || value < 1 || value > 262143)) return { error: '请输入 1–262143 的整数，或留空不锁' }
			return { bytes: [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff] }
		}
		return { error: '未知蜂窝搜网参数' }
	}

	return {
		BASE_WATER_LABEL: BASE_WATER_LABEL,
		largeFlowM3ToBytes: largeFlowM3ToBytes,
		settingRange: settingRange,
		settingNumber: settingNumber,
		settingBytes: settingBytes,
		unitsToM3: unitsToM3,
		cellularLockToBytes: cellularLockToBytes,
		filterPresets: filterPresets
	}
})()
