const supabase = require('../config/supabase')

// CREATE COHORT
const createCohort = async (req, res) => {
  try {
    console.log('=== CREATE COHORT DEBUG ===');
    console.log('Request body:', req.body);
    console.log('User:', req.user);
    
    const { name, description, startDate, endDate } = req.body

    // Validate required fields
    if (!name || !startDate || !endDate) {
      console.log('❌ Missing required fields');
      return res.status(400).json({ 
        message: 'Name, start date and end date are required',
        received: { 
          name: !!name, 
          startDate: !!startDate, 
          endDate: !!endDate 
        }
      })
    }

    // Validate date formats
    if (isNaN(new Date(startDate)) || isNaN(new Date(endDate))) {
      console.log('❌ Invalid date format');
      return res.status(400).json({ 
        message: 'Invalid date format. Please use valid dates.'
      })
    }

    if (new Date(startDate) > new Date(endDate)) {
      console.log('❌ Start date is after end date');
      return res.status(400).json({ 
        message: 'Start date must be before end date'
      })
    }

    const insertData = {
      name: name.trim(),
      description: description ? description.trim() : null,
      start_date: startDate,
      end_date: endDate,
      status: 'upcoming'
    };
    
    console.log('📤 Insert data:', insertData);

    const { data, error } = await supabase
      .from('cohorts')
      .insert(insertData)
      .select()
      .single()

    if (error) {
      console.error('❌ Supabase error details:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code
      });
      
      // Handle specific database errors
      if (error.code === '23505') {
        return res.status(409).json({ 
          message: 'A cohort with this name already exists'
        })
      }
      
      if (error.code === '23502') {
        return res.status(400).json({ 
          message: 'Missing required fields in database'
        })
      }
      
      throw error;
    }

    console.log('✅ Cohort created successfully:', data);
    console.log('=== END DEBUG ===');

    res.status(201).json({
      success: true,
      message: 'Cohort created successfully',
      cohort: data
    })
  } catch (error) {
    console.error('❌ Failed to create cohort:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to create cohort', 
      error: error.message,
      details: error.details || null,
      code: error.code || null
    })
  }
}

// GET ALL COHORTS
const getCohorts = async (req, res) => {
  try {
    console.log('=== FETCHING ALL COHORTS ===');
    
    const { data, error } = await supabase
      .from('cohorts')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('❌ Supabase error:', error);
      throw error;
    }

    console.log(`✅ Found ${data?.length || 0} cohorts`);
    
    res.json({ 
      success: true,
      cohorts: data || [],
      count: data?.length || 0
    })
  } catch (error) {
    console.error('❌ Failed to get cohorts:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to get cohorts', 
      error: error.message 
    })
  }
}

// GET SINGLE COHORT
const getCohort = async (req, res) => {
  try {
    const { id } = req.params
    
    if (!id) {
      return res.status(400).json({ 
        success: false,
        message: 'Cohort ID is required' 
      })
    }

    console.log(`📥 Fetching cohort: ${id}`);

    const { data, error } = await supabase
      .from('cohorts')
      .select('*')
      .eq('id', id)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        console.log(`❌ Cohort not found: ${id}`);
        return res.status(404).json({ 
          success: false,
          message: 'Cohort not found' 
        })
      }
      throw error;
    }

    if (!data) {
      return res.status(404).json({ 
        success: false,
        message: 'Cohort not found' 
      })
    }

    console.log(`✅ Cohort found: ${data.name}`);
    res.json({ 
      success: true,
      cohort: data 
    })
  } catch (error) {
    console.error(`❌ Failed to get cohort ${req.params.id}:`, error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to get cohort', 
      error: error.message 
    })
  }
}

// UPDATE COHORT
const updateCohort = async (req, res) => {
  try {
    const { id } = req.params
    const { name, description, startDate, endDate, status } = req.body

    if (!id) {
      return res.status(400).json({ 
        success: false,
        message: 'Cohort ID is required' 
      })
    }

    console.log(`📥 Updating cohort: ${id}`, req.body);

    // Validate dates if provided
    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
      return res.status(400).json({ 
        success: false,
        message: 'Start date must be before end date'
      })
    }

    // Build update object dynamically
    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (description !== undefined) updateData.description = description.trim() || null;
    if (startDate !== undefined) updateData.start_date = startDate;
    if (endDate !== undefined) updateData.end_date = endDate;
    if (status !== undefined) updateData.status = status;
    updateData.updated_at = new Date();

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'No fields to update' 
      })
    }

    console.log('📤 Update data:', updateData);

    const { data, error } = await supabase
      .from('cohorts')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('❌ Supabase error:', error);
      
      if (error.code === 'PGRST116') {
        return res.status(404).json({ 
          success: false,
          message: 'Cohort not found' 
        })
      }
      
      throw error;
    }

    if (!data) {
      return res.status(404).json({ 
        success: false,
        message: 'Cohort not found' 
      })
    }

    console.log(`✅ Cohort updated successfully: ${data.name}`);
    res.json({
      success: true,
      message: 'Cohort updated successfully',
      cohort: data
    })
  } catch (error) {
    console.error(`❌ Failed to update cohort ${req.params.id}:`, error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to update cohort', 
      error: error.message 
    })
  }
}

// DELETE COHORT
const deleteCohort = async (req, res) => {
  try {
    const { id } = req.params

    if (!id) {
      return res.status(400).json({ 
        success: false,
        message: 'Cohort ID is required' 
      })
    }

    console.log(`📥 Deleting cohort: ${id}`);

    // First check if cohort exists
    const { data: existingCohort, error: fetchError } = await supabase
      .from('cohorts')
      .select('id, name')
      .eq('id', id)
      .single()

    if (fetchError || !existingCohort) {
      return res.status(404).json({ 
        success: false,
        message: 'Cohort not found' 
      })
    }

    // Delete the cohort
    const { error } = await supabase
      .from('cohorts')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('❌ Supabase error:', error);
      throw error;
    }

    console.log(`✅ Cohort deleted successfully: ${existingCohort.name}`);
    res.json({ 
      success: true,
      message: 'Cohort deleted successfully',
      deletedCohort: existingCohort
    })
  } catch (error) {
    console.error(`❌ Failed to delete cohort ${req.params.id}:`, error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to delete cohort', 
      error: error.message 
    })
  }
}

module.exports = {
  createCohort, 
  getCohorts, 
  getCohort, 
  updateCohort, 
  deleteCohort
}