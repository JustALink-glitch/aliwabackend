const supabase = require('./config/supabase')

async function run() {
  const { data, error } = await supabase
    .from('sessions')
    .select('*, course:courses(name), trainer:users!sessions_trainer_id_fkey(id, first_name, last_name)')
  
  if (error) {
    console.error('getSessions select query failed!')
    console.error('Error Details:', error)
  } else {
    console.log('Query succeeded!')
    console.log('Sample data:', data.slice(0, 2))
  }
}

run()
