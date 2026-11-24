# backend/data

| ไฟล์ | คืออะไร | มาจากไหน |
|---|---|---|
| `customers.json` | **Master ลูกค้า** — จุดส่งของทุกแห่ง (`delivery_location_code`) พร้อมพิกัดและรัศมี geofence | รายชื่อจาก `[ScadaReport].[dbo].[SOI8_DEL_FNISP_DATA]` `where mot_name <> 'customer'` (อ่านอย่างเดียว ผ่าน endpoint export ประวัติของ SOI8) · พิกัดจาก OpenStreetMap Nominatim |
| `soi8_day.json` | แผนงานหนึ่งวันจริงที่ใช้เป็น mockup — รถ, FO, จุดส่ง, invoice | วันที่ 2026-11-13 ในตารางเดียวกัน (อ่านอย่างเดียว) |

## พิกัดลูกค้า (`geoSource`)

| ค่า | ความหมาย |
|---|---|
| `osm` | เจอโรงงาน/อาคารชื่อตรงกันใน OpenStreetMap ห่างจากนิคมของมันไม่เกิน 25 กม. |
| `area` | หาไม่เจอ — ใช้จุดกลางของพื้นที่ (เช่น อมตะนคร) กระจายออกเล็กน้อยไม่ให้หมุดทับกัน **เป็นตำแหน่งโดยประมาณ ควรแก้ในหน้า Master** |
| `manual` | มีคนแก้ตำแหน่งในหน้า Master แล้ว |
| `none` | ไม่มีตำแหน่งเลย |

ข้อมูลพิกัดจาก OpenStreetMap © OpenStreetMap contributors, ODbL — ต้องคงเครดิตนี้ไว้เมื่อนำไปใช้

แก้รัศมี/ตำแหน่งได้จากหน้า **ลูกค้า** ในแดชบอร์ด (บันทึกลง `customers.json` ทันที และ geofence ใช้ค่าใหม่ทันที)

สร้าง `customers.json` ใหม่จากผลค้นหา: `node tools/build-master.mjs <โฟลเดอร์ที่มี locations.json + geocoded.json>`
— ตำแหน่งที่แก้มือ (`manual`) และรัศมีที่ตั้งไว้แล้วจะไม่ถูกทับ
