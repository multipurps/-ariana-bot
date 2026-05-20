const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const useSupabaseAuthState = async (supabase) => {

  const writeData = async (id, data) => {
    const serialized = JSON.stringify(data, BufferJSON.replacer);
    const { error } = await supabase
      .from('baileys_auth')
      .upsert({ id, data: serialized }, { onConflict: 'id' });
    if (error) throw error;
  };

  const readData = async (id) => {
    try {
      const { data, error } = await supabase
        .from('baileys_auth')
        .select('data')
        .eq('id', id)
        .single();
      if (error || !data) return null;
      return JSON.parse(data.data, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = async (id) => {
    await supabase.from('baileys_auth').delete().eq('id', id);
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData('creds', creds)
  };
};

module.exports = { useSupabaseAuthState };
