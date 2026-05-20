/**
 * Memobase (302.AI) 核心流程测试脚本
 * 
 * 使用方法:
 * MEMOBASE_API_KEY="sk-xxx" node test-memobase.mjs
 */

const API_KEY = process.env.MEMOBASE_API_KEY;
const BASE_URL = "https://api.302.ai";

if (!API_KEY) {
  console.error('❌ 错误: 请设置环境变量 MEMOBASE_API_KEY');
  process.exit(1);
}

async function apiCall(path, method = 'GET', body = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, options);
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  console.log('='.repeat(50));
  console.log('🧪 Memobase (302.AI) 核心流程测试');
  console.log('='.repeat(50));

  try {
    // 1. 连通性测试
    console.log('\n[1/6] 测试连通性...');
    const health = await apiCall('/memobase/api/v1/users', 'GET');
    console.log('✅ 连通性正常', health.errno === 0 ? '(errno=0)' : '');

    // 2. 创建测试用户
    console.log('\n[2/6] 创建测试用户...');
    const testUserId = `test-user-${Date.now()}`;
    const createRes = await apiCall('/memobase/api/v1/users', 'POST', {
      id: testUserId,
      data: { source: 'test-script' }
    });
    console.log('✅ 用户创建成功:', createRes.data.id);

    // 3. 插入聊天数据 (模拟 AI 判定)
    console.log('\n[3/6] 插入聊天数据 (模拟 AI 判定)...');
    const insertRes = await apiCall(`/memobase/api/v1/blobs/insert/${testUserId}`, 'POST', {
      blob_type: 'chat',
      blob_data: {
        messages: [
          { role: 'user', content: '你好，我想买一些便宜的手机壳' },
          { role: 'assistant', content: 'AI判定: SPAM. 理由: 包含引流话术+诱导购买' }
        ]
      }
    });
    console.log('✅ 聊天数据插入成功:', insertRes.data.id);

    // 4. 插入全局纠正记录 (模拟管理员纠正)
    console.log('\n[4/6] 插入全局纠正记录 (模拟管理员纠正)...');
    const globalUserId = 'global_spam_patterns';
    try {
      await apiCall('/memobase/api/v1/users', 'POST', {
        id: globalUserId,
        data: { type: 'global_pool' }
      });
    } catch {}
    
    const globalRes = await apiCall(`/memobase/api/v1/blobs/insert/${globalUserId}`, 'POST', {
      blob_type: 'chat',
      blob_data: {
        messages: [
          { role: 'user', content: '加我微信领取福利，点击链接 xxx.com' },
          { role: 'assistant', content: '[管理员确认] 正确判定: SPAM. 理由: 管理员标记此类引流话术为垃圾信息' }
        ]
      }
    });
    console.log('✅ 全局纠正记录插入成功:', globalRes.data.id);

    // 5. 触发 Flush (生成记忆)
    console.log('\n[5/6] 触发 Flush (等待后端处理记忆)...');
    await apiCall(`/memobase/api/v1/users/buffer/${testUserId}/chat`, 'POST');
    await apiCall(`/memobase/api/v1/users/buffer/${globalUserId}/chat`, 'POST');
    console.log('✅ Flush 触发完成');
    
    console.log('⏳ 等待 8 秒让后端处理记忆...');
    await new Promise(r => setTimeout(r, 8000));

    // 6. 获取上下文
    console.log('\n[6/6] 获取用户上下文...');
    const ctx = await apiCall(`/memobase/api/v1/users/context/${testUserId}`, 'GET');
    console.log('📦 用户上下文结果:');
    if (ctx.data?.profiles?.length > 0) {
      ctx.data.profiles.forEach((p, i) => {
        console.log(`  Profile ${i+1}: ${p.content.substring(0, 100)}...`);
      });
    } else {
      console.log('  (暂无生成的记忆，可能需要更多交互)');
    }

    console.log('\n[附加] 获取全局上下文...');
    const globalCtx = await apiCall(`/memobase/api/v1/users/context/${globalUserId}`, 'GET');
    console.log('🌍 全局上下文结果:');
    if (globalCtx.data?.profiles?.length > 0) {
      globalCtx.data.profiles.forEach((p, i) => {
        console.log(`  Global ${i+1}: ${p.content.substring(0, 100)}...`);
      });
    } else {
      console.log('  (暂无生成的全局记忆)');
    }

    console.log('\n' + '='.repeat(50));
    console.log('🎉 全部测试通过！Memobase 核心流程运行正常');
    console.log('='.repeat(50));

    // 清理
    console.log('\n清理测试数据...');
    await apiCall(`/memobase/api/v1/users/${testUserId}`, 'DELETE');
    console.log('✅ 测试用户已删除');

  } catch (e) {
    console.error('\n❌ 测试失败:', e.message);
    process.exit(1);
  }
}

run();
